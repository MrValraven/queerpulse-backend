/**
 * The two appeal deadlines the Code of Conduct §05 publishes, in one place.
 *
 * §05 promises a member may appeal "within 14 days" of a decision and that the
 * appeal is "decided within 7 days" by a different moderator. Only the
 * different-moderator half was ever enforced (`ModerationService.reviewAppeal`).
 * The other two were published prose with nothing behind them: `Appeal` carried
 * no due date and no decision timestamp, so the 7-day promise could not even be
 * measured, let alone reported on.
 *
 * These constants are the single source for both windows, deliberately
 * mirroring how `reports/report-severity.ts` owns the report SLA
 * (`slaDueAtFor`). Change the published text and this file together.
 */

/**
 * How long a member has to file, counted from the moment the decision they are
 * contesting was TAKEN (the `mod_audit_logs` row's `created_at`).
 *
 * WHICH INSTANT STARTS THE CLOCK, and why it is that one: the audit row is
 * written inside the same transaction as the sanction, and the member's
 * outcome notification is sent immediately after that transaction commits
 * (`ModerationService.notifyModerationOutcome`). So the audit row's timestamp
 * is, to within a second, the instant the member was told. The alternatives
 * are worse: the report's `resolved_at` is the same instant for a
 * report-backed action but does not exist for a report-less one (a community
 * ban, a direct admin restriction), and the notification's own `created_at`
 * lives in a table this module does not own and is skipped entirely when the
 * moderator happens to be the member.
 *
 * A member who cannot sign in still reaches the appeal form: `POST /appeals`
 * is guarded by `AppealSubmitGuard`, the deliberate `ActiveMemberGuard`
 * exception, precisely so a suspended or banned account can file.
 */
export const APPEAL_FILING_WINDOW_DAYS = 14;

/** How long the platform has to decide an appeal once it is filed. */
export const APPEAL_DECISION_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export const APPEAL_FILING_WINDOW_MS = APPEAL_FILING_WINDOW_DAYS * DAY_MS;
export const APPEAL_DECISION_WINDOW_MS = APPEAL_DECISION_WINDOW_DAYS * DAY_MS;

/**
 * When an appeal filed at `filedAt` must be decided by. Stored on
 * `appeals.sla_due_at` at filing, exactly the way `reports.sla_due_at` is
 * computed from severity at report creation, so the appeals queue can page on
 * it with the same keyset machinery.
 *
 * Flat, not severity-scaled. §05 publishes one number for every appeal, and a
 * shorter internal clock for an emergency-severity appeal would be a promise
 * the published text does not make (while a longer one for a low-severity
 * appeal would break the one it does).
 */
export function appealDecisionDueAt(filedAt: Date): Date {
  return new Date(filedAt.getTime() + APPEAL_DECISION_WINDOW_MS);
}

/** The instant the filing window closes for a decision taken at `decidedAt`. */
export function appealFilingWindowClosesAt(decisionTakenAt: Date): Date {
  return new Date(decisionTakenAt.getTime() + APPEAL_FILING_WINDOW_MS);
}

/**
 * Whether a filing at `filedAt` is inside the published window for a decision
 * taken at `decisionTakenAt`.
 *
 * The boundary is inclusive: an appeal filed at exactly the closing instant is
 * accepted. A window a member is told is 14 days long should not refuse them on
 * a millisecond.
 */
export function isWithinAppealFilingWindow(
  decisionTakenAt: Date,
  filedAt: Date,
): boolean {
  return (
    filedAt.getTime() <= appealFilingWindowClosesAt(decisionTakenAt).getTime()
  );
}
