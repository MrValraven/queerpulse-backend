/**
 * How long the partnerships queue has to answer an organisation that applied
 * to partner with QueerPulse (OPS-04).
 *
 * ONE PLACE, ON PURPOSE — the constant below is the whole policy, and the
 * backfill in `AddQueueAssignmentAndDueClocks` derives from it.
 *
 * Fourteen days. A partner application is the slowest thing in this set on
 * purpose: it is an organisation, the answer usually needs more than one
 * person, and nobody's access to the platform is blocked while it is open. The
 * window exists because the alternative was what OPS-04 found, an application
 * sitting for six weeks with nothing anywhere going red.
 */
export const PARTNER_APPLICATION_REVIEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The due date for an application submitted at `from`. */
export function partnerApplicationDueAt(from: Date): Date {
  return new Date(from.getTime() + PARTNER_APPLICATION_REVIEW_WINDOW_MS);
}
