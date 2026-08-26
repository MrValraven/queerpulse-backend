/**
 * How long the verification review queue has to decide a request (OPS-04).
 *
 * ONE PLACE, ON PURPOSE — see `membership/join-request-sla.ts` for the same
 * note. These two constants and `verificationRequestDueAt` are the whole
 * policy; the backfill in `AddQueueAssignmentAndDueClocks` derives from them.
 *
 * Five days for a first request. A member has asked for a level they do not
 * have yet, so nothing they can do today is blocked by the wait, and the
 * review is a judgement a reviewer should be able to sit on overnight.
 *
 * Three for an appeal. An appeal is a SECOND wait on the same question: the
 * member has already been through the queue once and been told no. Starting
 * their clock again at five days would mean a rejected request can honestly
 * take ten days to settle. The shorter window says the second look is owed
 * faster than the first.
 */
export const VERIFICATION_REVIEW_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

export const VERIFICATION_APPEAL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** The due date for a request submitted at `from`. */
export function verificationRequestDueAt(isAppeal: boolean, from: Date): Date {
  const window = isAppeal
    ? VERIFICATION_APPEAL_WINDOW_MS
    : VERIFICATION_REVIEW_WINDOW_MS;
  return new Date(from.getTime() + window);
}
