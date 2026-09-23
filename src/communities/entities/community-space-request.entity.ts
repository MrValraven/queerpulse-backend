import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lifecycle of a request to let a community host spaces. `open` is where every
 * request starts. Platform staff move it to `approved` (which also switches
 * `allowsSubcommunities` on) or `declined`; the community's owner or a
 * co-owner can move it to `withdrawn`. Only `open` blocks a second request.
 */
export enum CommunitySpaceRequestStatus {
  Open = 'open',
  Approved = 'approved',
  Declined = 'declined',
  Withdrawn = 'withdrawn',
}

/**
 * A community owner or co-owner asking platform staff to switch spaces on
 * (`POST /communities/:slug/space-requests`), decided from the
 * `admin/community-space-requests` queue. Approving runs through
 * `AdminCommunitiesService.updateSettings`, the same path as the "Allow
 * spaces" switch, so the governance log reads the same either way.
 *
 * At most ONE open request per community, enforced by the partial unique
 * index `UQ_community_space_requests_open`, the precedent set by
 * `UQ_community_owner_review_requests_open`. Closed rows stay as history.
 *
 * Paired migration `AddCommunitySpaceRequests`.
 */
@Entity('community_space_requests')
@Index('UQ_community_space_requests_open', ['communityId'], {
  unique: true,
  where: `"status" = 'open'`,
})
export class CommunitySpaceRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // CASCADE on the community: a deleted community has nothing left to decide.
  @Index('IDX_community_space_requests_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  // CASCADE on the requester, like `community_tag_request`: with the requester
  // erased the row is a dead letter, and another owner or co-owner can ask.
  @Index('IDX_community_space_requests_requested_by_user_id')
  @Column({ type: 'uuid' })
  requestedByUserId!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Index('IDX_community_space_requests_status')
  @Column({
    type: 'enum',
    enum: CommunitySpaceRequestStatus,
    enumName: 'community_space_request_status_enum',
    default: CommunitySpaceRequestStatus.Open,
  })
  status!: CommunitySpaceRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // Stamped on approve, decline or withdraw.
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  // The deciding admin, or the staff member who withdrew. SET NULL on erasure
  // so the record of a decision survives the person.
  @Index('IDX_community_space_requests_decided_by_user_id')
  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  declineReason!: string | null;
}
