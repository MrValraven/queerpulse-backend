import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum EventCommunityStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

/**
 * A guest community on a gathering (2026-10-08 guest communities design).
 * `events.community_id` stays the lead; each row here is one more community
 * the organiser invited. Only an `accepted` row puts the guest's name on the
 * gathering, lists it on the guest's page and widens the `community`
 * audience. A `declined` row is final for that gathering: the unique pair
 * below keeps the organiser from inviting the same community twice.
 *
 * Column names come from `SnakeNamingStrategy`. Paired migration
 * `AddEventCommunities1831300000000`.
 */
@Entity('event_communities')
@Unique('UQ_event_communities_event_community', ['eventId', 'communityId'])
export class EventCommunity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_event_communities',
  })
  id!: string;

  // Per-gathering reads ride the unique pair's index, whose leading column
  // is `event_id`, so this column carries no index of its own.
  @Column({ type: 'uuid' })
  eventId!: string;

  // Partial: the community page, the feed and the digest only ever ask for
  // the gatherings a community joined as an ACCEPTED guest.
  @Index('IDX_event_communities_accepted_community_id', {
    where: `"status" = 'accepted'`,
  })
  @Index('IDX_event_communities_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @Column({
    type: 'enum',
    enum: EventCommunityStatus,
    enumName: 'event_communities_status_enum',
    default: EventCommunityStatus.Pending,
  })
  status!: EventCommunityStatus;

  // `SET NULL` on account erasure: the invite outlives whoever sent it.
  @Index('IDX_event_communities_invited_by_user_id')
  @Column({ type: 'uuid', nullable: true })
  invitedByUserId!: string | null;

  @Index('IDX_event_communities_responded_by_user_id')
  @Column({ type: 'uuid', nullable: true })
  respondedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
