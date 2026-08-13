/**
 * The lifecycle of a member-submitted verification request. A request starts
 * `pending`, a moderator may pull it `in_review`, then decides `approved` or
 * `rejected`. A `rejected` request may be appealed exactly once (→
 * `appealing`, which re-enters the review loop). The member may `withdrawn`
 * a request themselves while it is still open. See `LEGAL_TRANSITIONS` below
 * for exactly which moves are allowed from which state — enforced
 * server-side in `VerificationService.decideRequest`/`appealRequest`/
 * `withdrawRequest` (Task 3), never trusted from the client.
 */
export enum VerificationRequestStatus {
  Pending = 'pending',
  InReview = 'in_review',
  Approved = 'approved',
  Rejected = 'rejected',
  Appealing = 'appealing',
  Withdrawn = 'withdrawn',
}

/** Legal next-states. Empty array = terminal for the actor path. Enforced server-side. */
export const LEGAL_TRANSITIONS: Record<VerificationRequestStatus, VerificationRequestStatus[]> = {
  [VerificationRequestStatus.Pending]: [
    VerificationRequestStatus.InReview,
    VerificationRequestStatus.Approved,
    VerificationRequestStatus.Rejected,
    VerificationRequestStatus.Withdrawn,
  ],
  [VerificationRequestStatus.InReview]: [
    VerificationRequestStatus.Approved,
    VerificationRequestStatus.Rejected,
    VerificationRequestStatus.Withdrawn,
  ],
  [VerificationRequestStatus.Rejected]: [VerificationRequestStatus.Appealing],
  [VerificationRequestStatus.Appealing]: [
    VerificationRequestStatus.InReview,
    VerificationRequestStatus.Approved,
    VerificationRequestStatus.Rejected,
  ],
  [VerificationRequestStatus.Approved]: [],
  [VerificationRequestStatus.Withdrawn]: [],
};
