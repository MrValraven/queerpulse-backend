import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lifecycle of an owner-review request. `open` is where every request starts;
 * `resolved` is platform staff having acted (reassigned the owner, or decided
 * the owner is fine); `withdrawn` is the requesting member taking it back.
 * Only `open` blocks a second request being filed for the same community.
 */
export enum CommunityOwnerReviewRequestStatus {
  Open = 'open',
  Resolved = 'resolved',
  Withdrawn = 'withdrawn',
}

/**
 * A community's members flagging that their owner is unreachable, so platform
 * staff can look at reassigning the community. Filing is open to the whole
 * roster except the owner (GOV-02); it was moderators and co-owners only when
 * this table was introduced, which left an abandoned community with no
 * moderator unable to report anything at all.
 *
 * Until now `communities.needs_owner_review_at` was stamped by exactly one
 * automatic path (`CommunityOwnerOrphanService.handleOwnerErasure`, an owner
 * who erased their account with no mod to promote). The commoner failure is an
 * owner who simply stopped showing up, which nothing on the platform could
 * express. Filing a request here stamps that same `needsOwnerReviewAt` and
 * notifies platform staff, so both routes land on one admin surface.
 *
 * A community can carry at most ONE open request at a time, enforced by the
 * partial unique index `UQ_community_owner_review_requests_open`
 * (`WHERE status = 'open'`), the precedent set by
 * `UQ_community_join_requests_pending` and `UQ_reports_open_reporter_subject`.
 * Closed requests stay as history, and a community can be flagged again later.
 *
 * Paired migration `1793930000000-AddCommunityOwnerReviewRequests`.
 */
@Entity('community_owner_review_requests')
@Index('UQ_community_owner_review_requests_open', ['communityId'], {
  unique: true,
  where: `"status" = 'open'`,
})
export class CommunityOwnerReviewRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // CASCADE on the community: a deleted community has nothing left to review.
  @Index('IDX_community_owner_review_requests_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  // The member who filed it. Nullable and `ON DELETE SET NULL` for account
  // erasure, the actor-FK convention this module follows: the request is about
  // the community's governance and must survive the requester's account.
  @Column({ type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  // Why the filer thinks the owner is gone. Staff-facing.
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({
    type: 'enum',
    enum: CommunityOwnerReviewRequestStatus,
    enumName: 'community_owner_review_requests_status_enum',
    default: CommunityOwnerReviewRequestStatus.Open,
  })
  status!: CommunityOwnerReviewRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // Stamped when the request leaves `open` by either route (staff resolving it
  // or the requester withdrawing it). NULL exactly while the request is open.
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;
}
