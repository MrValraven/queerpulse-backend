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
 *  - `suggest_edit`      → resources/SuggestEditModal (glossary edit)
 *  - `sober_host`        → resources/SoberHostModal
 *  - `panel_signup`      → resources/PanelSignupModal
 *  - `incubator_cohort`  → economy/IncubatorModals · CohortApplyModal
 *  - `incubator_mentor`  → economy/IncubatorModals · MentorSignupModal
 *  - `incubator_session` → economy/IncubatorModals · RequestSessionModal
 */
export const INTAKE_KINDS = [
  'grant',
  'suggest_edit',
  'sober_host',
  'panel_signup',
  'incubator_cohort',
  'incubator_mentor',
  'incubator_session',
] as const;

export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** Ops triage state. New rows land as `new`; staff flip them to `reviewed`. */
export type IntakeStatus = 'new' | 'reviewed';

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
