/**
 * The numbers the published safe-space copy commits the platform to, in one
 * place so a service, a scheduled sweep and a response mapper can never quote
 * three different promises back to a member.
 *
 * The copy (frontend `catalogs/en/safety.ts`) promises six steps: a nomination
 * acknowledged within 48 hours, three independent member visits, a review
 * panel, a badge, an annual re-review, and "three flags trigger an immediate
 * review and temporary suspension". Every constant below is one of those
 * sentences.
 */

/** "We acknowledge your nomination within 48 hours." */
export const SAFE_SPACE_ACKNOWLEDGEMENT_HOURS = 48;

/** "Three independent members visit before a badge is granted." */
export const SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS = 3;

/** "Three flags trigger an immediate review and a temporary suspension." */
export const SAFE_SPACE_FLAG_SUSPENSION_THRESHOLD = 3;

/** "Every badge is re-reviewed once a year." */
export const SAFE_SPACE_RE_REVIEW_INTERVAL_DAYS = 365;

const HOUR_IN_MS = 60 * 60 * 1000;
const DAY_IN_MS = 24 * HOUR_IN_MS;

/** When the 48-hour acknowledgement promise falls due for a nomination. */
export function acknowledgementDueAt(receivedAt: Date): Date {
  return new Date(
    receivedAt.getTime() + SAFE_SPACE_ACKNOWLEDGEMENT_HOURS * HOUR_IN_MS,
  );
}

/** Whole hours a nomination has been waiting, floored at 0. */
export function ageInHours(receivedAt: Date, now: Date = new Date()): number {
  const elapsed = now.getTime() - receivedAt.getTime();
  return elapsed > 0 ? Math.floor(elapsed / HOUR_IN_MS) : 0;
}

/**
 * When a badge awarded (or last re-verified) on `awardedOn` falls due for its
 * annual re-review. `awardedOn` is the `listings.safe_space_re_verified_at`
 * date column, so it arrives as a `YYYY-MM-DD` string; an unparseable or
 * absent value yields `null`, which reads as "never awarded, nothing due".
 */
export function reReviewDueAt(awardedOn: string | null): Date | null {
  if (!awardedOn) return null;
  const awarded = new Date(`${awardedOn}T00:00:00.000Z`);
  if (Number.isNaN(awarded.getTime())) return null;
  return new Date(
    awarded.getTime() + SAFE_SPACE_RE_REVIEW_INTERVAL_DAYS * DAY_IN_MS,
  );
}

/** True once a badge has been carrying its own word for more than a year. */
export function isDueForReReview(
  awardedOn: string | null,
  now: Date = new Date(),
): boolean {
  const due = reReviewDueAt(awardedOn);
  return due !== null && due.getTime() <= now.getTime();
}

/** `YYYY-MM-DD` for a `date` column, in UTC so the value never drifts a day. */
export function toDateColumnValue(when: Date): string {
  return when.toISOString().slice(0, 10);
}
