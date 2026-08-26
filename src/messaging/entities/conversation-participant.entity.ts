import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A participant's standing in a GROUP thread (feature #17). Every pre-group row
 * and both sides of a DM default to `member`; a group's creator is seeded as
 * `owner`. Phase 1 only SETS this column (creator = owner) — Phase 2 enforces
 * what each role may do (add/remove members, rename, promote/demote).
 */
export enum ConversationRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
}

@Entity('conversation_participants')
@Unique('UQ_conversation_participants', ['conversationId', 'userId'])
export class ConversationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_conversation_participants_conversation_id')
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Index('IDX_conversation_participants_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Group standing. `member` for DMs and every pre-group row; a group creator is
   * `owner`. Set at creation in Phase 1; role-gated actions arrive in Phase 2.
   */
  @Column({
    type: 'enum',
    enum: ConversationRole,
    enumName: 'conversation_participants_role_enum',
    default: ConversationRole.Member,
  })
  role!: ConversationRole;

  /**
   * When this participant LEFT a group. The row is kept (not deleted) so past
   * messages still resolve the member's identity and the system-message history
   * ("Cy left") stays intact. NULL = still an active member. A left member keeps
   * read access to history but is blocked from sending.
   */
  @Column({ type: 'timestamptz', nullable: true })
  leftAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt!: Date | null;

  /**
   * Delivered watermark: everything in this conversation created at-or-before
   * this instant has reached this participant's device (they acked receipt over
   * the socket, or fetched/read the thread). One rung below `lastReadAt` — read
   * implies delivered, so `markRead` advances both. Null until the first ack.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  clearedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  muted!: boolean;

  /**
   * When this participant PINNED the conversation to the top of their own inbox.
   * A per-participant preference (like `muted`), stored as a timestamp — not a
   * boolean — so pins sort deterministically (most-recently-pinned first) and it
   * matches the other watermark columns above. NULL = not pinned. Capped at 3
   * pinned conversations per user, enforced in `ConversationsService.setPinned`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  pinnedAt!: Date | null;

  /**
   * When this participant FAVORITED the conversation. A per-participant
   * preference (like `muted`), stored as a timestamp for the same reasons as
   * `pinnedAt`. NULL = not favorited.
   */
  @Column({ type: 'timestamptz', nullable: true })
  favoritedAt!: Date | null;

  /**
   * When this participant ARCHIVED the conversation out of their main inbox.
   * A per-participant preference (like `muted`/`pinnedAt`), stored as a
   * timestamp so it could sort ("most recently archived first") if the
   * Archived tab ever wants that. NULL = not archived.
   *
   * Auto-cleared (unarchived) the instant a genuinely NEW message lands in
   * the conversation — see `MessagingCoreService.buildPostResult` — so an
   * archived thread can never silently swallow a reply the way a
   * `deletedAt`-style hard clear could. This is the intended replacement for
   * "clear for me" (`clearedAt`) as the everyday way to declutter the inbox:
   * reversible, and it resurfaces itself the moment the conversation is
   * live again. `clearedAt` itself is untouched — it keeps its own,
   * separate, still-destructive "delete for me" meaning.
   */
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  /**
   * This participant's unsent composer text for the conversation, synced from
   * the client so it survives a device switch (phone -> laptop) — the
   * cross-device layer on top of the instant, always-on localStorage copy the
   * composer itself writes on every keystroke (`features/messages/drafts.ts`).
   * Debounced on the client (`PATCH /conversations/:id { draft }`); NULL/empty
   * once the draft is sent or explicitly cleared. Never broadcast over the
   * realtime socket — it is this participant's own unsent text, nobody else's
   * concern, and reading it back only ever happens on this participant's own
   * `GET /conversations`.
   */
  @Column({ type: 'text', nullable: true })
  draft!: string | null;
}
