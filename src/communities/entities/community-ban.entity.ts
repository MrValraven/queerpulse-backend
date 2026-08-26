import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A member barred from one community by that community's owner/mods.
 *
 * A ban is a row here rather than a status on `community_members`, because a
 * ban has to OUTLIVE the roster row: removing someone and then having them
 * re-join through the public/request door is exactly the loop a ban exists to
 * close. So the moderation path deletes the `community_members` row and
 * inserts here, and every join path (join, accept invite, approve join
 * request) checks this table first.
 *
 * Community-scoped only. A platform-level ban lives in the moderation module
 * and is a different, heavier thing: this one says "not in this room" and says
 * nothing about the member's standing anywhere else on QueerPulse.
 *
 * Paired migrations: `1793800000000-AddCommunityBans`,
 * `1794910000000-AddCommunityBanExpiry` (the `expires_at` end date) and
 * `1794911000000-AddCommunityBanRuleCitation` (the cited house rule).
 */
@Entity('community_bans')
@Index('UQ_community_bans_community_user', ['communityId', 'userId'], {
  unique: true,
})
export class CommunityBan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // CASCADE on the community: a deleted community has no bans to enforce.
  // Indexed because the hot read is "is this user banned from this community",
  // and the mod panel's ban list is "every ban for this community".
  @Index('IDX_community_bans_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  // The banned member. CASCADE on the user: an erased account cannot walk back
  // through the door, so keeping the row would only retain a name for no
  // enforcement value.
  @Column({ type: 'uuid' })
  userId!: string;

  // The owner/mod who applied the ban. Nullable and `ON DELETE SET NULL` for
  // account erasure, the actor-FK convention this module already follows
  // (see `Community.ownerId` and
  // `FixCommunityOwnerAuthorErasureCascades1789900000000`): the moderator
  // leaving the platform must never lift a ban they applied. NULL reads as
  // "the moderator who did this is gone", and the ban still stands.
  @Column({ type: 'uuid', nullable: true })
  bannedByUserId!: string | null;

  // Moderator-authored, optional. Shown to owner/mods on the ban list, carried
  // into the governance log, and (since TS-10) sent to the barred member with
  // their notification: a sanction nobody explains is the unexplained
  // enforcement the notification pipeline exists to prevent.
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  // When the bar lifts by itself. NULL means permanent, which is what every
  // ban written before `AddCommunityBanExpiry1794910000000` was.
  //
  // A timed ban is the rung the community ladder was missing. Removal used to
  // be all-or-nothing, so a moderator facing someone having a bad week chose
  // between doing nothing and barring them for life. A ban with an end date is
  // the same act with a horizon on it.
  //
  // Enforcement is by QUERY, never by a sweep job: every read that asks "is
  // this member barred" filters on `expires_at IS NULL OR expires_at > now()`,
  // so an expired row stops biting the instant it expires even if nothing has
  // deleted it yet. `CommunitiesService.assertNotBanned` additionally deletes
  // the spent row on the way past (lazy expiry with write-through, the pattern
  // `JwtStrategy.liftExpiredRestriction` uses for `users.restricted_until`),
  // which keeps the ban list honest without a scheduled job.
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  // The house rule this ban rests on, snapshotted at the moment of the action.
  //
  // `Community.rules` is a plain `string[]` and `Community.rulesVersion` is
  // bumped on every edit, so an index alone is unstable: rule 3 today can be a
  // different rule tomorrow. Storing the version AND the exact wording means
  // the record still reads correctly after the rules are rewritten, and a
  // reader can see at a glance whether they have been.
  //
  // All three are NULL together. Citing a rule is optional (a ban can rest on
  // conduct no rule anticipated), and a community with no rules has nothing to
  // cite.
  @Column({ type: 'int', nullable: true })
  ruleIndex!: number | null;

  @Column({ type: 'int', nullable: true })
  ruleVersion!: number | null;

  @Column({ type: 'text', nullable: true })
  ruleText!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
