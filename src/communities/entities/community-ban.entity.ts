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
 * Paired migration `1793800000000-AddCommunityBans`.
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

  // Moderator-authored, optional. Shown to owner/mods on the ban list and
  // carried into the governance log; whether any of it reaches the banned
  // member is a decision for the notification/response layer, not this column.
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
