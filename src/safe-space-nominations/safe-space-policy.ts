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

/**
 * Refusal code when a badge is asked for below
 * {@link SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS} independent visits and no
 * written override reason came with it.
 *
 * An exported constant rather than an inline literal, matching
 * `VERIFICATION_REQUIRED_CODE` and its neighbours, so the specs and both award
 * paths import the one spelling. The frontend branches on this value and never
 * on message text.
 *
 * BOTH doors to a badge answer with it: the reviewed nomination path
 * (`SafeSpaceNominationsService.decide`) and the direct mark
 * (`ListingsService.setSafeSpace`).
 */
export const SAFE_SPACE_VISIT_BAR_NOT_MET_CODE = 'SAFE_SPACE_VISIT_BAR_NOT_MET';

/**
 * Refusal code when a caller who reached the endpoint on the additive
 * `directory_moderator` grant alone tries to OVERRIDE the visit bar.
 *
 * Deciding a nomination is a directory moderator's job and stays theirs: they
 * may award above the bar and they may decline. Waiving a guarantee the
 * platform publishes is a platform-level act, so it is limited to a real
 * `moderator`/`admin` account tier.
 *
 * Distinct from {@link SAFE_SPACE_VISIT_BAR_NOT_MET_CODE}, and answered with a
 * 403 rather than a 400, because the two are different problems: one says
 * "write a reason", the other says "this is not yours to waive". A client that
 * conflated them would tell a delegate to write a reason they can never use.
 */
export const SAFE_SPACE_VISIT_BAR_OVERRIDE_FORBIDDEN_CODE =
  'SAFE_SPACE_VISIT_BAR_OVERRIDE_FORBIDDEN';

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
