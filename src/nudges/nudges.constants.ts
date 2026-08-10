// The fixed set of discoverable "persona nudge" moments (Personas Phase 5 —
// see `docs/superpowers/plans/2026-08-10-personas-phase5-discovery.md`
// Decision §1). `NudgesService.dismiss` rejects any `nudgeKey` outside this
// set with a 400 rather than trusting the client to send a known moment.
export const NUDGE_KEYS = [
  'profile_empty',
  'directory_footer',
  'account_badge',
  'onboarding_question',
  'post_gathering',
  'credit_notification',
] as const;

export type NudgeKey = (typeof NUDGE_KEYS)[number];

export function isNudgeKey(value: string): value is NudgeKey {
  return (NUDGE_KEYS as readonly string[]).includes(value);
}

// After this many distinct dismissals, every remaining nudge moment stops
// firing for the caller (`account_badge` is exempt — it is a persistent
// count, not a dismissible nudge, and is never written to this table).
export const NUDGE_CAP = 2;
