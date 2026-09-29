/**
 * The magazine's clock: the desk's own time zone, the hour an issue goes live,
 * and the calendar arithmetic every issue and piece date compares against.
 * Pure functions, so the piece service, the issue announcer and the public
 * read paths all share one definition of "today" and "live".
 */

export const MAGAZINE_TIMEZONE = 'Europe/Lisbon';

/**
 * The hour a scheduled issue goes live, in `MAGAZINE_TIMEZONE`. The ship copy
 * has always promised "everything publishes together at 09:00 on the issue
 * date" (PRD-126); this is that promise as a number.
 */
export const ISSUE_PUBLISH_HOUR = 9;

/**
 * How far `instant` is ahead of UTC in `timeZone`, in milliseconds.
 *
 * Renders the instant in the target zone and reads the wall-clock fields back
 * as if they were UTC: the difference IS the offset. Same technique (and same
 * reason) as `localMinuteOfDay` in `notification-quiet-hours.ts`: the zone
 * database inside `Intl` already knows about DST, so this stays correct across
 * the changeover without a date library.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const partValue = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const wallClockAsUtc = Date.UTC(
    partValue('year'),
    partValue('month') - 1,
    partValue('day'),
    // `hour12: false` renders midnight as `24` in some ICU versions; fold it
    // back, exactly as `localMinuteOfDay` does.
    partValue('hour') % 24,
    partValue('minute'),
    partValue('second'),
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * Whether a `publishedAt` means "live to readers RIGHT NOW". A `null` is a
 * draft and a FUTURE instant is a schedule; both are invisible to every public
 * read path, so neither counts as published.
 */
export function isLiveInstant(
  publishedAt: Date | null,
  now: Date = new Date(),
): boolean {
  return publishedAt !== null && publishedAt.getTime() <= now.getTime();
}

/**
 * Today as a `YYYY-MM-DD` calendar date in `MAGAZINE_TIMEZONE`, so an issue
 * date typed by the desk is compared against the desk's own day. `en-CA`
 * renders exactly `YYYY-MM-DD`, which is also how `MagazineIssue.publishedOn`
 * comes back off its Postgres `date` column, so the two compare as strings.
 */
export function magazineTodayIsoDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MAGAZINE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The latest `published_on` a reader may see at `now`.
 *
 * An issue dated D goes live at `ISSUE_PUBLISH_HOUR` on D in
 * `MAGAZINE_TIMEZONE`, so from that hour onward today's issue is visible, and
 * before it the newest visible issue date is yesterday. Returned as
 * `YYYY-MM-DD` so it compares as a string against `MagazineIssue.publishedOn`,
 * like `magazineTodayIsoDate`.
 */
export function magazineIssueVisibleThroughDate(
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MAGAZINE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const partValue = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const year = partValue('year');
  const month = partValue('month');
  const day = partValue('day');
  // Folded like `zoneOffsetMs`: some ICU versions render midnight as `24`.
  const hour = partValue('hour') % 24;

  // `Date.UTC` rolls day 0 back into the previous month (and year), so the
  // day before the first of the month needs no special case.
  const visibleDay = hour >= ISSUE_PUBLISH_HOUR ? day : day - 1;
  return new Date(Date.UTC(year, month - 1, visibleDay))
    .toISOString()
    .slice(0, 10);
}

/**
 * PRD-126: when a ship's pieces should actually go live.
 *
 * Ship copy promises the issue lands together at 09:00 on the issue date, but
 * `shipIssue` used to publish at the instant of the click: an editor who
 * shipped on Friday for a Monday issue put every article live on Friday while
 * the issue page itself stayed hidden until Monday.
 *
 * So: an issue dated today or in the past goes live NOW (the desk is catching
 * up, and holding it back would be a surprise), and a FUTURE issue date
 * resolves to 09:00 Europe/Lisbon on that date. A future `publishedAt` already
 * hides an article or deck from every public read path, so scheduling costs
 * nothing beyond this arithmetic: no cron, no second column.
 *
 * The offset is measured twice because 09:00 can sit on the far side of a DST
 * changeover from the first guess. Lisbon changes at 01:00, so one correction
 * pass is always enough.
 */
export function resolveIssuePublishInstant(
  publishedOn: string,
  shippedAt: Date,
): Date {
  // Compared as calendar dates in the magazine's own zone, so an issue dated
  // TODAY ships now even when the click lands at 07:00, because an editor
  // shipping today's issue means today, and holding it two hours for a clock
  // they never chose would be the surprise this fix exists to remove.
  if (publishedOn <= magazineTodayIsoDate(shippedAt)) {
    return shippedAt;
  }

  const wallClockAsUtc = new Date(
    `${publishedOn}T${String(ISSUE_PUBLISH_HOUR).padStart(2, '0')}:00:00Z`,
  );
  if (Number.isNaN(wallClockAsUtc.getTime())) {
    return shippedAt;
  }

  const firstGuessOffsetMs = zoneOffsetMs(wallClockAsUtc, MAGAZINE_TIMEZONE);
  let publishAt = new Date(wallClockAsUtc.getTime() - firstGuessOffsetMs);
  const settledOffsetMs = zoneOffsetMs(publishAt, MAGAZINE_TIMEZONE);
  if (settledOffsetMs !== firstGuessOffsetMs) {
    publishAt = new Date(wallClockAsUtc.getTime() - settledOffsetMs);
  }

  // A future issue date's 09:00 is always ahead of the click, so this is a
  // belt-and-braces floor that keeps the go-live at or after the click.
  return publishAt.getTime() > shippedAt.getTime() ? publishAt : shippedAt;
}
