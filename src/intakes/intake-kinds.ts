/**
 * The closed set of intake forms the generic `POST /intakes/:kind` accepts.
 * The `:kind` path param is validated against this allowlist before anything
 * is written, so an arbitrary/unknown kind can never create a row. Kinds are
 * stored as a plain varchar column (not a Postgres enum) so adding a future
 * form never needs an enum migration — the allowed values live here and are
 * enforced by {@link isIntakeKind} on the way in (same rationale as the
 * `inquiries` table's `@IsIn` kind).
 *
 * Each value maps to exactly one frontend intake modal:
 *  - `grant`             → resources/GrantApplicationModal
 *  - `suggest_edit`      → resources/SuggestEditModal, opened from
 *                          resources/SuggestEditTrigger. Started as a
 *                          glossary-only edit form; now shared by Legal,
 *                          Trans Healthcare, Harm Reduction, Mental Health and
 *                          the Library grid too. The jsonb payload's
 *                          `context` field (e.g. "glossary", "legal",
 *                          "library") tells staff which surface a suggestion
 *                          came from — no schema change needed to add it.
 *  - `sober_host`        → resources/SoberHostModal
 *  - `panel_signup`      → resources/PanelSignupModal
 *  - `incubator_cohort`  → economy/IncubatorModals · CohortApplyModal
 *  - `incubator_mentor`  → economy/IncubatorModals · MentorSignupModal
 *  - `incubator_session` → economy/IncubatorModals · RequestSessionModal
 *  - `governance_concern`→ governance/GovernanceSections · RaiseSection
 *                          (the public "Submit a concern" form; staff triage it
 *                          on the /admin/concerns dashboard)
 *  - `culture_suggest_pick`    → culture/CultureFormModals · SuggestPickModal
 *  - `culture_post_project`    → culture/CultureFormModals · PostProjectModal
 *  - `culture_submit_work`     → culture/CultureFormModals · SubmitWorkModal
 *  - `culture_submit_playlist` → culture/CultureFormModals · SubmitPlaylistModal
 *                          (Culture's four member-submission forms: previously
 *                          wired to a prototype-only local timer that never
 *                          sent anything anywhere; now recorded for real
 *                          through this same generic pipeline, same as every
 *                          other kind above. No dedicated admin page reads
 *                          them yet — visible via `GET /intakes?kind=...` —
 *                          so their success copy makes no reply-time promise.)
 */
export const INTAKE_KINDS = [
  'grant',
  'suggest_edit',
  'sober_host',
  'panel_signup',
  'incubator_cohort',
  'incubator_mentor',
  'incubator_session',
  'governance_concern',
  'culture_suggest_pick',
  'culture_post_project',
  'culture_submit_work',
  'culture_submit_playlist',
] as const;

export type IntakeKind = (typeof INTAKE_KINDS)[number];

/**
 * Ops triage states. New rows land as `new`. The generic intake forms flip to
 * `reviewed` once handled; the governance-concern dashboard uses the richer
 * `reviewing`/`resolved`/`dismissed` worklist (a concern is confidential and
 * gets an outcome, not just a "seen" flag). All are plain varchar values — no
 * enum migration is needed to widen this set (see the entity note).
 */
export const INTAKE_STATUSES = [
  'new',
  'reviewed',
  'reviewing',
  'resolved',
  'dismissed',
] as const;

export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/**
 * The triage states an admin can move a concern into from the dashboard. `new`
 * is the initial state a row is created in, never a target of a manual update.
 */
export const CONCERN_TRIAGE_STATUSES = [
  'reviewing',
  'resolved',
  'dismissed',
] as const;

export type ConcernTriageStatus = (typeof CONCERN_TRIAGE_STATUSES)[number];

/**
 * Kinds that require an authenticated member. These are reached only from the
 * gated `/economy/*` incubator surface (see the frontend `authGate` —
 * `/economy` and `/economy/*` are member-only), so an anonymous submission is
 * never legitimate and is rejected. Every other kind is a public
 * marketing/resource form a logged-out visitor can submit (the resources pages
 * stay public), and its `submitterId` is captured best-effort when the caller
 * happens to be signed in.
 */
export const MEMBER_ONLY_INTAKE_KINDS: ReadonlySet<IntakeKind> =
  new Set<IntakeKind>([
    'incubator_cohort',
    'incubator_mentor',
    'incubator_session',
  ]);

export function isIntakeKind(value: string): value is IntakeKind {
  return (INTAKE_KINDS as readonly string[]).includes(value);
}
