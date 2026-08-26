import type { IntakeKind } from './intake-kinds';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long staff have to work an intake submission, per form (OPS-04).
 *
 * ONE PLACE, ON PURPOSE. An operator changing what this platform promises
 * itself about a given form changes it here and nowhere else; the backfill in
 * `AddQueueAssignmentAndDueClocks` derives from the same numbers.
 *
 * The set is deliberately keyed exhaustively by `IntakeKind` rather than
 * defaulted: adding a thirteenth form should make the compiler ask what its
 * window is, instead of quietly inheriting someone else's answer.
 *
 * Three tiers, and the reasoning is about the person waiting:
 *  - `governance_concern` (3 days). Someone has raised a concern about how
 *    this place is run, often about a person with power in it. A concern that
 *    sits is a concern that has been answered.
 *  - signups that hold a date open (7 days) — `sober_host` and
 *    `panel_signup` are people volunteering for something that happens on a
 *    calendar, and a late yes is a no.
 *  - everything else (14 days): applications, suggestions and submissions
 *    where nobody's plans are on hold. Two weeks is slow, and it is honest.
 *    The point is that six weeks now goes red.
 */
const INTAKE_REVIEW_WINDOW_MS: Record<IntakeKind, number> = {
  governance_concern: 3 * DAY_MS,
  sober_host: 7 * DAY_MS,
  panel_signup: 7 * DAY_MS,
  grant: 14 * DAY_MS,
  suggest_edit: 14 * DAY_MS,
  incubator_cohort: 14 * DAY_MS,
  incubator_mentor: 14 * DAY_MS,
  incubator_session: 14 * DAY_MS,
  culture_suggest_pick: 14 * DAY_MS,
  culture_post_project: 14 * DAY_MS,
  culture_submit_work: 14 * DAY_MS,
  culture_submit_playlist: 14 * DAY_MS,
};

/** The due date for a submission of `kind` received at `from`. */
export function intakeDueAt(kind: IntakeKind, from: Date): Date {
  return new Date(from.getTime() + INTAKE_REVIEW_WINDOW_MS[kind]);
}

/** The window itself, for the one caller that needs the number rather than a
 *  date (the migration's per-kind backfill is written in SQL from these). */
export function intakeReviewWindowMs(kind: IntakeKind): number {
  return INTAKE_REVIEW_WINDOW_MS[kind];
}
