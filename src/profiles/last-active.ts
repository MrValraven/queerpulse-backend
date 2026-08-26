/**
 * The "recently active" signal, in its entirety.
 *
 * WHAT IS STORED: one `date` per member, always pinned to the first day of a
 * month (`2026-08-01`). No timestamp, no day, no hour, no login count, no
 * device. The most precise question this column can answer is "which month did
 * this member last hold a live session in", and that is deliberate: a precise
 * last-seen time on a directory of queer people is a movement log, and a green
 * presence dot is the same log rendered live. QueerPulse ships neither.
 *
 * WHAT IS SHOWN: never the stored value. The read path collapses the month into
 * one of three bands (see `ActivityBand`), so two members who signed in five
 * weeks apart can still render identically, and nobody can watch the signal
 * tick over in real time.
 *
 * WHAT IS UNKNOWN STAYS UNKNOWN: `bandFor(null)` returns `null`, and every
 * surface renders `null` as nothing at all. The column is not backfilled, so on
 * the day this ships every existing member has no value. Rendering those as
 * "not active recently" would libel the whole directory at once, on data the
 * platform never collected.
 *
 * This file is pure: no Nest, no TypeORM, no clock of its own. Every function
 * takes the instant it should reason about, so the coarsening and the band
 * boundaries are directly testable (see `last-active.spec.ts`).
 */

/**
 * The three coarse bands a member's stored month collapses to on the way out.
 *
 * `Dormant` is "the last live session was more than three months ago", which is
 * as specific as this signal ever gets. There is no "a year ago" band: past the
 * three-month boundary the useful answer for a member deciding whether to send
 * a message is the same, and finer bands would only re-introduce precision.
 */
export enum ActivityBand {
  ThisMonth = 'thisMonth',
  LastThreeMonths = 'last3Months',
  Dormant = 'dormant',
}

/** Months past the current one before a member reads as dormant. */
export const RECENT_BAND_MONTHS = 3;

/** Zero-padded two-digit number, for the `YYYY-MM-DD` string builders below. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Coarsen an instant to the first day of its month, as the `YYYY-MM-DD` string
 * Postgres stores in a `date` column and TypeORM hands back verbatim.
 *
 * UTC on both sides on purpose. A server that moves timezone (or a deploy
 * region change) must not be able to shift a member's stored month by one, and
 * a `date` column carries no zone to disambiguate it later.
 */
export function coarsenToMonth(at: Date): string {
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-01`;
}

/**
 * The UTC calendar day of an instant, used only as the in-memory once-a-day
 * throttle key. Never stored: this string exists for the length of one process
 * and never reaches Postgres or a response body.
 */
export function dayKey(at: Date): string {
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Months since year zero, so two months can be subtracted as plain integers. */
function monthIndex(year: number, monthZeroBased: number): number {
  return year * 12 + monthZeroBased;
}

/**
 * Parse a stored `YYYY-MM-DD` month back to its month index. Returns `null` for
 * anything that is not a well-formed date string, so a hand-edited or legacy
 * row degrades to "unknown" rather than throwing inside a directory listing.
 */
function storedMonthIndex(storedMonth: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(storedMonth.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return null;
  }
  return monthIndex(year, month - 1);
}

/**
 * The band a stored month reads as, relative to `now`.
 *
 * `null` in means `null` out: an unknown month is not a dormant member (see the
 * file header). A month in the future reads as `ThisMonth` rather than throwing
 * or reading as dormant, because the only way to get one is clock skew between
 * an app instance and the database, and that must not flip a member's badge to
 * its most damaging value.
 */
export function bandFor(
  storedMonth: string | null | undefined,
  now: Date,
): ActivityBand | null {
  if (!storedMonth) {
    return null;
  }
  const stored = storedMonthIndex(storedMonth);
  if (stored === null) {
    return null;
  }
  const current = monthIndex(now.getUTCFullYear(), now.getUTCMonth());
  const monthsAgo = current - stored;
  if (monthsAgo <= 0) {
    return ActivityBand.ThisMonth;
  }
  if (monthsAgo <= RECENT_BAND_MONTHS) {
    return ActivityBand.LastThreeMonths;
  }
  return ActivityBand.Dormant;
}

/**
 * What one member's activity signal looks like once it has been read.
 *
 * `isHidden` is the member's own opt-out. It travels with the band rather than
 * being applied at the query, because the OWNER still needs to see their own
 * band on their own profile: a privacy switch whose effect you cannot see is a
 * switch nobody trusts.
 */
export interface ActivitySignal {
  band: ActivityBand | null;
  isHidden: boolean;
}

/**
 * The band a given viewer may see. Everyone but the member themselves gets
 * `null` once the member has opted out, which is the same shape
 * `gateAvatarUrl`/`gateLocation` use for the other member-controlled fields.
 */
export function visibleBand(
  signal: ActivitySignal | undefined,
  isOwner: boolean,
): ActivityBand | null {
  if (!signal) {
    return null;
  }
  if (signal.isHidden && !isOwner) {
    return null;
  }
  return signal.band;
}
