import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Discriminates a 1:1 DM from a multi-party group thread (feature #17). Existing
 * rows default to `direct` in the migration, so every DM predating group chat
 * (and the official/welcome thread, which is `direct` + `isOfficial`) keeps its
 * exact behaviour. Orthogonal to `isOfficial`: an official thread is still a
 * `direct` kind — group is specifically the member-created, titled, N-member
 * thread. Phase 2 builds member management/roles on top of this.
 */
export enum ConversationKind {
  Direct = 'direct',
  Group = 'group',
}

@Entity('conversations')
@Index('IDX_conversations_initiator_user_id', ['initiatorUserId'], {
  where: '"initiator_user_id" IS NOT NULL',
})
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'boolean', default: false })
  isOfficial!: boolean;

  /**
   * PRD-372: the one member an official thread belongs to. NULL for every
   * DM and group. `UQ_conversations_official_member` (partial, WHERE NOT NULL)
   * makes "one official thread per member" a database guarantee; only
   * `OfficialConversationsService` writes it. FK `ON DELETE CASCADE`.
   */
  @Column({ type: 'uuid', nullable: true })
  officialMemberId!: string | null;

  /**
   * `direct` (1:1 DM / official thread) or `group` (member-created, titled,
   * multi-participant). Defaults to `direct` so all pre-group rows are DMs.
   */
  @Column({
    type: 'enum',
    enum: ConversationKind,
    enumName: 'conversations_kind_enum',
    default: ConversationKind.Direct,
  })
  kind!: ConversationKind;

  /** Group name. NULL for DMs (their name is the counterpart's profile). */
  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  /** Group avatar (storage key/URL). NULL for DMs (counterpart's avatar). */
  @Column({ type: 'varchar', nullable: true })
  avatarUrl!: string | null;

  /**
   * The member who created a group (also seeded as its `owner` participant).
   * NULL for DMs and for groups whose creator's account was later deleted
   * (FK is `ON DELETE SET NULL`).
   */
  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  // Canonical sorted "userA:userB" key for 1:1 conversations — a UNIQUE guard
  // against duplicate threads under concurrent materialization. NULL for
  // official/group threads (Postgres treats NULLs as distinct in a UNIQUE index).
  @Index('UQ_conversations_pair_key', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  pairKey!: string | null;

  /**
   * PRD-340: who started this thread as COLD contact. Set only by a
   * deliberately connection-bypassing delivery (today: only
   * `MessageRequestsService.deliverEnquiry`). NULL for a group/official
   * thread and for an ordinary DM between members who were already connected
   * when it was created, since recording an initiator there would let a
   * later disconnect's reply gate treat ordinary message history as consent
   * to reopen the thread, which this feature must never infer. Set once, at
   * creation or (for `deliverEnquiry`) the first time it reaches an existing
   * un-initiated, un-opened thread; never updated after that. Only
   * `openedAt` moves from then on. FK `ON DELETE SET NULL`.
   */
  @Column({ type: 'uuid', nullable: true })
  initiatorUserId!: string | null;

  /**
   * PRD-340: the instant the member who did NOT initiate this non-connected
   * DM posted their first reply (`MessagesService.sendMessage`'s
   * connection-gate block). From then on an ordinary send from EITHER side
   * is allowed, exactly as if they were connected. NULL means still gated,
   * or never needed gating at all (an already-connected DM, a group, or an
   * official thread). A block between the two resets this to NULL
   * (`ConversationsService`'s `MEMBER_BLOCKED` handler), so unblocking
   * without reconnecting requires the non-initiator to re-open it instead of
   * silently resuming. Removing an ACCEPTED connection does NOT clear this:
   * the recipient already consented by replying, and that explicit reply is
   * exactly the mechanism this feature is allowed to rely on.
   */
  @Column({ type: 'timestamptz', nullable: true })
  openedAt!: Date | null;

  /**
   * PRD-363: the `openedAt` a block voided, kept so lifting the block puts the
   * thread back exactly as open as it was. Set by `ConversationsService`'s
   * `MEMBER_BLOCKED` handler, restored and cleared by its `MEMBER_UNBLOCKED`
   * handler once no block remains in either direction. NULL when there is
   * nothing to restore.
   */
  @Column({ type: 'timestamptz', nullable: true })
  openedAtBeforeBlock!: Date | null;

  /**
   * PRD-358: the group's about text, member-authored, sanitised the same way a
   * caption is (trimmed, control characters/markup stripped, max 500) at the
   * write boundary in `GroupsService`. NULL for DMs and for a group that has
   * never set one.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  /**
   * PRD-358: the active join-by-link token, or NULL when no link is live. A
   * partial UNIQUE index (`UQ_conversations_invite_token`, WHERE NOT NULL)
   * guards it, so rotating simply writes a fresh random token over the old one
   * (invalidating it) and disabling clears this back to NULL. Only surfaced to
   * an owner/admin of an active, non-dissolved group
   * (`ConversationResponse.inviteToken`), never a plain member, never a DM.
   */
  // Mirrors `1819000000000-AddGroupConsentInvitesAndDissolve`'s partial
  // UNIQUE index, same as `UQ_messages_conversation_client_id` on
  // `message.entity.ts` mirrors its own migration-created partial index, so
  // `migration:generate` never proposes dropping it.
  @Index('UQ_conversations_invite_token', {
    unique: true,
    where: '"invite_token" IS NOT NULL',
  })
  @Column({ type: 'varchar', length: 64, nullable: true })
  inviteToken!: string | null;

  /**
   * PRD-357: when this group's owner ended it (or the last leaver did, with no
   * successor to hand it to). NULL means active. Once set the group is
   * read-only: every write route refuses with `GROUP_DISSOLVED`, enforced in
   * the service layer, not here. NULL for DMs, which are never dissolved.
   */
  @Column({ type: 'timestamptz', nullable: true })
  dissolvedAt!: Date | null;

  /**
   * The one staff member currently answering a shared business mailbox
   * thread. Claiming narrows push to that person (Task 12) and tells
   * colleagues the thread is already handled. NULL means unclaimed, which is
   * also what a release restores. Taken with a conditional UPDATE guarded on
   * `claimed_by_user_id IS NULL` (`ConversationsService.claim`), so the
   * database itself settles two simultaneous claims on exactly one winner.
   * Meaningless for an ordinary member-to-member DM or group. FK `ON DELETE
   * SET NULL`: a claimant whose account is later erased leaves the thread
   * simply unclaimed, with a partial index for that lookup.
   */
  @Index('IDX_conversations_claimed_by_user_id', {
    where: '"claimed_by_user_id" IS NOT NULL',
  })
  @Column({ type: 'uuid', nullable: true })
  claimedByUserId!: string | null;

  /** When the current claim was taken. NULL exactly when `claimedByUserId` is. */
  @Column({ type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  /**
   * Task 19: who last released this thread's claim, so an idle claim never
   * locks the mailbox and colleagues can see who let it go (spec 4.3). NULL
   * when nobody has released it, after any later claim or take-over (each
   * clears it), and after a system release of a claimant who left the
   * business (`claimReleasedAt` set, this NULL).
   *
   * The five claim columns hold the LATEST change only. Every claim write
   * (`ConversationsService.claim`, `takeOver`, `release`) sets all five in
   * one conditional UPDATE, so the row never holds a mixed state. There is
   * deliberately no history table: the maintainer's rule is no behaviour
   * analytics, and the latest change is all specs 4.3 and 6.5 ask for. FK
   * `ON DELETE SET NULL`, with a partial index for that lookup.
   */
  @Index('IDX_conversations_claim_released_by_user_id', {
    where: '"claim_released_by_user_id" IS NOT NULL',
  })
  @Column({ type: 'uuid', nullable: true })
  claimReleasedByUserId!: string | null;

  /** Task 19: when the claim was last released. NULL while a claim is held
   *  and before any release. */
  @Column({ type: 'timestamptz', nullable: true })
  claimReleasedAt!: Date | null;

  /**
   * Task 19: whose claim the current claimant took over (spec 6.5, a visible
   * take-over that names who did it). NULL for an ordinary claim and for an
   * unclaimed thread. FK `ON DELETE SET NULL`, with a partial index for that
   * lookup.
   */
  @Index('IDX_conversations_claim_taken_over_from_user_id', {
    where: '"claim_taken_over_from_user_id" IS NOT NULL',
  })
  @Column({ type: 'uuid', nullable: true })
  claimTakenOverFromUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
