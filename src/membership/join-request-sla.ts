/**
 * How long the invite-request queue has to answer an applicant (OPS-04).
 *
 * ONE PLACE, ON PURPOSE. Change the constant below and every new request, the
 * admin queue's overdue treatment and the backfill in
 * `AddQueueAssignmentAndDueClocks` all move together. Nothing else in the
 * codebase should hard-code a review window for this queue.
 *
 * Three days is not invented here: it is the window the invite-review
 * guideline audit settled on, and the admin card has been colouring a wait of
 * three days or more as overdue ever since (`JoinRequestCard.waitingTone`).
 * This makes that promise a stored date the server owns rather than a number
 * living in one React component.
 *
 * Plain elapsed days, never "business days". An applicant waiting to hear
 * whether they can join does not experience a weekend as a pause, and a
 * business-day clock would need a holiday calendar per country to mean
 * anything.
 */
export const JOIN_REQUEST_REVIEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** The due date for a request submitted at `from`. */
export function joinRequestDueAt(from: Date): Date {
  return new Date(from.getTime() + JOIN_REQUEST_REVIEW_WINDOW_MS);
}
