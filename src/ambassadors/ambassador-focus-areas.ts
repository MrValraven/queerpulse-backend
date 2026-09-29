/**
 * The curated list staff pick an ambassador's focus from. Mirrored by the
 * frontend's `ambassadorFocusAreas.data.ts`; the labels live in the i18n
 * catalogs, so a key here with no label renders as a raw key there.
 */
export const AMBASSADOR_FOCUS_AREAS = [
  'trans_health',
  'sexual_health',
  'mental_health',
  'housing',
  'nightlife_safety',
  'work_and_careers',
  'youth',
  'elders',
  'migrants_and_refugees',
  'sport',
  'arts_and_culture',
  'rights_and_activism',
] as const;

export type AmbassadorFocusArea = (typeof AMBASSADOR_FOCUS_AREAS)[number];

export function isAmbassadorFocusArea(
  value: unknown,
): value is AmbassadorFocusArea {
  return (
    typeof value === 'string' &&
    (AMBASSADOR_FOCUS_AREAS as readonly string[]).includes(value)
  );
}

/** Monthly invites an active ambassador gets on top of base + level bonus. */
export const AMBASSADOR_INVITE_BONUS = 10;
