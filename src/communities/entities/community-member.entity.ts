import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum RosterRole {
  Owner = 'owner',
  // A roster role carrying owner-level powers, added by
  // `1793920000000-AddCommunityCoOwnerRole`. The single-owner constraint on
  // `communities.owner_id` is UNCHANGED by this value: that column still holds
  // exactly one accountable owner of record, and it is still the column every
  // ownership transfer, orphan-handling and admin surface reads. A co-owner is
  // a member the owner has handed owner-level powers to inside the community
  // (settings, roster, moderation), and the platform never treats them as the
  // community's owner of record. Promoting a co-owner to actual owner is still
  // an explicit ownership transfer.
  CoOwner = 'co_owner',
  Mod = 'mod',
  Member = 'member',
}

/**
 * How much a member wants to hear from one community. Per-member and
 * per-community, so someone can sit quietly in twelve rooms and still be
 * paged by the one they organise.
 *
 * `all` is every post, `announcements` is only what an owner/mod marks as an
 * announcement, `mentions` is only threads where the member is named, and
 * `muted` is nothing at all from this community (the member's platform-wide
 * notification preferences still apply on top; this level can only ever
 * reduce what they receive, never add to it).
 *
 * Defaults to `announcements` rather than `all`, because a member of a busy
 * community who gets notified on every post learns to ignore the bell, and
 * because that is the level that keeps the important thing loud.
 */
export enum CommunityNotificationLevel {
  All = 'all',
  Announcements = 'announcements',
  Mentions = 'mentions',
  Muted = 'muted',
}

// Covers `CommunitiesService.roster`'s paginated `WHERE community_id = ...
// ORDER BY joined_at ASC` in one index walk — see
// `1785700400000-AddCommunityMembersRosterOrderIndex.ts`.
@Index('IDX_community_members_roster_order', ['communityId', 'joinedAt'])
@Entity('community_members')
@Unique('UQ_community_members', ['communityId', 'userId'])
export class CommunityMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_members_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @Index('IDX_community_members_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: RosterRole,
    enumName: 'community_members_role_enum',
  })
  role!: RosterRole;

  // How much this member wants to hear from this community (see
  // `CommunityNotificationLevel`). NOT NULL with a server-side default, so
  // every existing roster row and every future insert has a definite level and
  // no notification path has to treat NULL as a special case. Paired migration
  // `1793830000000-AddCommunityMemberNotificationLevel`.
  @Column({
    type: 'enum',
    enum: CommunityNotificationLevel,
    enumName: 'community_members_notification_level_enum',
    default: CommunityNotificationLevel.Announcements,
  })
  notificationLevel!: CommunityNotificationLevel;

  // When this member last agreed to the community's rules, and which version
  // of them (`communities.rules_version`) they agreed to. Both nullable,
  // because every member on the roster today joined before rules acceptance
  // existed, and backfilling a consent nobody actually gave would be a lie.
  // Read them as a pair: NULL `rulesVersionAccepted`, or a value lower than
  // the community's current `rulesVersion`, means this member should be
  // re-prompted. Paired migration
  // `1793810000000-AddCommunityRulesAcceptance`.
  @Column({ type: 'timestamptz', nullable: true })
  rulesAcceptedAt!: Date | null;

  @Column({ type: 'integer', nullable: true })
  rulesVersionAccepted!: number | null;

  // Stamped the first time this member is shown the community's
  // `welcomeMessage`, which is what makes it a once-only greeting. NULL means
  // "not shown yet", so the welcome step fires on their next visit; a member
  // who joined before this column existed sees the welcome once and then never
  // again, which is the intended behaviour rather than a backfill problem.
  // Paired migration `1793850000000-AddCommunityWelcomeMessage`.
  @Column({ type: 'timestamptz', nullable: true })
  welcomeSeenAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt!: Date;
}
