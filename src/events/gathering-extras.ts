import { BadRequestException } from '@nestjs/common';

/**
 * The care layer a host adds to a gathering beyond its format: themes, content
 * notes, house rules, the cost kind, when RSVPs close, and which extra
 * questions the RSVP details modal asks.
 *
 * THIS MODULE IS THE ONE PLACE these vocabularies and caps are declared, so
 * the migration, the entity, the DTO validators, the service, the response
 * mapper and the specs cannot drift apart. It deliberately imports nothing
 * from the entity layer (the entity imports its types from here), the same
 * arrangement `gathering-family.ts` keeps.
 *
 * The frontend mirrors this in `gatheringExtras.ts` (queerpulse repo). Keys
 * on both sides are identical and stay fixed once shipped: they are stored
 * values, and the labels live in the frontend's i18n catalogs.
 */

/** Themes a host can pin to a gathering's card. At most three per gathering. */
export const GATHERING_THEME_KEYS = [
  'trans-led',
  'sober',
  'adults-only',
  'beginners-welcome',
  'portuguese-practice',
  'newcomers-to-lisbon',
  'family-friendly',
  'sapphic',
] as const;
export type GatheringTheme = (typeof GATHERING_THEME_KEYS)[number];
export const MAX_GATHERING_THEMES = 3;

/** Heads-up notes about what a gathering contains, so a member can decide
 *  before they set out. */
export const CONTENT_NOTE_KEYS = [
  'sexual-content',
  'violence',
  'transphobia-discussion',
  'flashing-lights',
  'loud-sound',
  'alcohol-present',
] as const;
export type ContentNote = (typeof CONTENT_NOTE_KEYS)[number];

/**
 * When RSVPs close, measured back from the gathering's start. `at-start`
 * closes them the moment the gathering starts. A stored `null` means the host
 * set no cutoff: RSVPs stay open until the gathering ends, where `hasEnded`
 * closes them.
 */
export const RSVP_CUTOFF_VALUES = [
  'at-start',
  'one-hour-before',
  'day-before',
  'three-days-before',
] as const;
export type RsvpCutoff = (typeof RSVP_CUTOFF_VALUES)[number];

/** How a gathering is paid for. Display only: this platform takes no payment,
 *  so no reader of this value may promise a charge, a ticket or a refund. */
export const COST_KIND_VALUES = ['free', 'pay-what-you-can', 'fixed'] as const;
export type CostKind = (typeof COST_KIND_VALUES)[number];

export const MAX_HOUSE_RULES_LENGTH = 160;
export const MAX_CUSTOM_RSVP_QUESTION_LENGTH = 120;
export const MAX_RSVP_PRONOUNS_LENGTH = 60;
export const MAX_RSVP_CUSTOM_ANSWER_LENGTH = 500;

/**
 * Which optional questions the RSVP details modal asks, stored whole in
 * `events.rsvp_questions`.
 *
 * Always a complete three-key map on write, so every key a reader looks up
 * holds a real answer, and `false` means the host switched that question off.
 * The modal asks access needs regardless of `access` (the platform's
 * accessibility baseline); the flag records the host's own choice and is
 * echoed as sent.
 */
export interface RsvpQuestions {
  dietary: boolean;
  pronouns: boolean;
  access: boolean;
}

export const RSVP_QUESTION_KEYS: readonly (keyof RsvpQuestions)[] = [
  'dietary',
  'pronouns',
  'access',
];

/** What a brand-new gathering asks when the host sends nothing: none of the
 *  optional questions. Rows that predate this column were backfilled to ask
 *  dietary and access by the migration, which preserves the modal they had. */
export const DEFAULT_RSVP_QUESTIONS: Readonly<RsvpQuestions> = {
  dietary: false,
  pronouns: false,
  access: false,
};

/**
 * A complete question map: every key the patch sets as a boolean wins, every
 * other key keeps its value from `base`, and a key neither side holds is
 * `false`.
 *
 * Used for both writes. Create passes `DEFAULT_RSVP_QUESTIONS` as the base;
 * update passes the stored map, which is how a PATCH toggling one question
 * leaves the other two alone.
 */
export function mergeRsvpQuestions(
  base: Partial<RsvpQuestions> | null | undefined,
  patch?: Partial<RsvpQuestions> | null,
): RsvpQuestions {
  const merged: RsvpQuestions = { ...DEFAULT_RSVP_QUESTIONS };
  for (const key of RSVP_QUESTION_KEYS) {
    const patchedValue = patch?.[key];
    const baseValue = base?.[key];
    if (typeof patchedValue === 'boolean') {
      merged[key] = patchedValue;
    } else if (typeof baseValue === 'boolean') {
      merged[key] = baseValue;
    }
  }
  return merged;
}

/** How long before `startAt` each cutoff closes RSVPs. Plain elapsed
 *  milliseconds on the instant, so "a day before" is exactly 24 hours earlier
 *  whatever the gathering's time zone does in between. */
const RSVP_CUTOFF_LEAD_MILLISECONDS: Readonly<Record<RsvpCutoff, number>> = {
  'at-start': 0,
  'one-hour-before': 60 * 60 * 1000,
  'day-before': 24 * 60 * 60 * 1000,
  'three-days-before': 72 * 60 * 60 * 1000,
};

/**
 * The instant RSVPs close, or `null` when the host set no cutoff (RSVPs then
 * stay open until the gathering ends). `at-start` returns `startAt` itself.
 *
 * A value outside the vocabulary (a hand-edited row) also reads as `null`, so
 * an unreadable cutoff leaves RSVPs open, the behaviour every gathering had
 * before cutoffs existed.
 */
export function rsvpClosesAt(
  startAt: Date,
  cutoff: RsvpCutoff | null,
): Date | null {
  if (!cutoff) return null;
  const leadMilliseconds = RSVP_CUTOFF_LEAD_MILLISECONDS[cutoff];
  if (leadMilliseconds === undefined) return null;
  return new Date(startAt.getTime() - leadMilliseconds);
}

/** Whether `now` is at or past the gathering's RSVP cutoff. A gathering with
 *  no cutoff stays open under this rule (`hasEnded` still closes it). */
export function hasRsvpCutoffPassed(
  event: { startAt: Date; rsvpCutoff?: RsvpCutoff | null },
  now: Date = new Date(),
): boolean {
  const closesAt = rsvpClosesAt(event.startAt, event.rsvpCutoff ?? null);
  return closesAt !== null && now.getTime() >= closesAt.getTime();
}

export const RSVPS_CLOSED_MESSAGE = 'RSVPs for this gathering have closed';

/**
 * The one cutoff guard every member-initiated way onto a roster calls: a
 * first RSVP, a revived cancelled one, a step up to going from maybe or from
 * the waitlist, accepting an invite, and a member raising their guest count
 * (`updateRsvpDetails`).
 *
 * Organiser actions (promoting from the waitlist, the automatic promotion a
 * freed seat triggers) and every way OFF a roster (cancelling, stepping down
 * to maybe) run without it. A host who set a cutoff to get final numbers still
 * needs to seat someone at the door, and a member who can no longer come
 * must always be able to say so, since that is what frees the seat.
 */
export function assertRsvpsOpen(
  event: { startAt: Date; rsvpCutoff?: RsvpCutoff | null },
  now: Date = new Date(),
): void {
  if (hasRsvpCutoffPassed(event, now)) {
    throw new BadRequestException(RSVPS_CLOSED_MESSAGE);
  }
}
