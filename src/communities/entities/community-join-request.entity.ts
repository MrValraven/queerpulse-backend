/**
 * COMMUNITY-LEVEL join request: an existing platform member asking to join
 * one gated community, reviewed by that community's mods. Do not confuse
 * this with the PLATFORM-LEVEL join request in
 * `src/membership/entities/join-request.entity.ts`, which is a stranger with
 * no account asking to join QueerPulse itself. The two share names
 * (`JoinRequest`, `JoinRequestStatus`, approve/decline) and vocabulary, but
 * are otherwise unrelated: different tables (`community_join_requests` vs
 * `join_requests`), different controllers/services, no shared code.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum JoinRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

/**
 * What the applicant said they want out of the community, asked as one
 * multiple-choice question in the join modal. Values mirror the frontend's
 * `INVOLVEMENT` list (`src/features/communities/joinModal.data.ts`) exactly,
 * because those `value` strings are the stored ids: `updates` is "keep me in
 * the loop", `active` is "I'll show up and take part", `organise` is "I want
 * to help run things". Adding an option means adding it in both places.
 *
 * Reviewers use it to read a queue quickly and to spot the people worth
 * inviting into organising. It is self-reported and carries no authority: it
 * never gates admission and never sets a roster role.
 */
export enum CommunityJoinRequestInvolvement {
  Updates = 'updates',
  Active = 'active',
  Organise = 'organise',
}

/**
 * Which of the two kinds of "no" a decline was. The distinction is the whole
 * point: `not_now` is a timing answer (the community is full, or is pausing
 * intake, or wants the applicant to come back after an event), so the
 * applicant is told they may reapply and `reapplyAfter` says when. `not_a_fit`
 * is a fit answer, and carries no invitation to try again.
 *
 * Kept separate from `declineReason` so the product can be warm and specific
 * without a moderator having to write the same paragraph every time, and so a
 * reapply gate can be enforced without parsing free text.
 */
export enum CommunityJoinRequestDeclineKind {
  NotNow = 'not_now',
  NotAFit = 'not_a_fit',
}

// Note: the "at most one pending join request per (community, user)" rule is
// enforced by a partial unique index in the migration
// (`UQ_community_join_requests_pending` ... WHERE status = 'pending'), not by
// a TypeORM decorator — mirrors `join-request.entity.ts` +
// `AddJoinRequestPendingUnique`.
@Entity('community_join_requests')
@Index('UQ_community_join_requests_pending', ['communityId', 'userId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class CommunityJoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_join_requests_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @Index('IDX_community_join_requests_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'community_join_requests_status_enum',
    default: JoinRequestStatus.Pending,
  })
  status!: JoinRequestStatus;

  // The applicant's self-reported answer to "how do you want to take part"
  // (see `CommunityJoinRequestInvolvement`). Nullable: the question is
  // optional in the join modal, and every request filed before this column
  // existed has no answer. Paired migration
  // `1793820000000-AddCommunityJoinRequestReviewFields`.
  @Column({
    type: 'enum',
    enum: CommunityJoinRequestInvolvement,
    enumName: 'community_join_requests_involvement_enum',
    nullable: true,
  })
  involvement!: CommunityJoinRequestInvolvement | null;

  // What the reviewer wrote when declining, intended to reach the applicant.
  // Anything the reviewer wants to keep between moderators belongs in
  // `internalNote` instead. NULL on every request that was not declined, and
  // on a decline where the reviewer chose to say nothing.
  @Column({ type: 'text', nullable: true })
  declineReason!: string | null;

  // Which kind of "no" this was (see `CommunityJoinRequestDeclineKind`). NULL
  // while pending or approved, and NULL on declines that predate this column,
  // which readers should treat as an unqualified decline rather than assuming
  // either kind. Paired migration
  // `1793820000000-AddCommunityJoinRequestReviewFields`.
  @Column({
    type: 'enum',
    enum: CommunityJoinRequestDeclineKind,
    enumName: 'community_join_requests_decline_kind_enum',
    nullable: true,
  })
  declineKind!: CommunityJoinRequestDeclineKind | null;

  // The earliest moment this applicant may file another request for this
  // community, set alongside a `not_now` decline. NULL means no waiting
  // period, so the join path must read it as "may reapply now" and never as
  // "may never reapply": a permanent bar is a ban
  // (`community_bans`), which is a different row in a different table.
  @Column({ type: 'timestamptz', nullable: true })
  reapplyAfter!: Date | null;

  // Which moderator has picked this request up, and when. A queue several
  // moderators watch at once otherwise gets the same applicant reviewed twice
  // (or, worse, replied to twice with different answers). Claiming is
  // advisory: it does not lock the row and any moderator may still act, it
  // just makes "someone is on this" visible. Both NULL on an unclaimed
  // request. `ON DELETE SET NULL` on the claimer for account erasure, the
  // actor-FK convention this module follows. Paired migration
  // `1793910000000-AddCommunityJoinRequestClaim`.
  @Column({ type: 'uuid', nullable: true })
  claimedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  // MODERATOR-ONLY working notes on this request, NEVER shown to the applicant
  // and never included in any applicant-facing response. This is where "I know
  // her from the choir, she's fine" and "second person from that account this
  // week" go, so `declineReason` can stay the thing the applicant actually
  // reads. Any response builder that serialises a join request for its own
  // applicant must omit this column.
  @Column({ type: 'text', nullable: true })
  internalNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
