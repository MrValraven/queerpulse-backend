import { BadRequestException } from '@nestjs/common';

// Reason code the following list reads to name why a `before` cursor was
// refused: the client sent a cursor this server never issued (hand-edited,
// truncated in transit, or minted by an older format). The client maps it to
// "start the list again from the top".
export const FOLLOWING_CURSOR_INVALID_CODE = 'FOLLOWING_CURSOR_INVALID';

/**
 * Upper bound for the raw `before` query string. A real cursor is 86
 * characters (base64url of a 27-character timestamp, a separator and a
 * 36-character uuid); the bound leaves headroom while refusing a payload large
 * enough to be worth decoding.
 */
export const FOLLOWING_CURSOR_MAX_LENGTH = 128;

/**
 * The position of one row in the following list, whose order is
 * `subprofile_followers.created_at DESC, id DESC`.
 *
 * `followedAt` is the timestamp as Postgres rendered it, in UTC with all six
 * fractional digits (`2026-11-05T12:00:00.123456Z`). It is carried as text on
 * purpose: `created_at` holds microseconds and a JS `Date` holds milliseconds,
 * so a cursor rebuilt from a `Date` would sit up to a millisecond away from
 * the real row, and every follow saved inside that millisecond after it would
 * be skipped by the `<` comparison.
 */
export interface FollowingCursorPosition {
  followedAt: string;
  followId: string;
}

const CURSOR_SEPARATOR = '|';
const MICROSECOND_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SQL that renders `created_at` in the exact shape `decodeFollowingCursor`
 * accepts. Postgres renders the text, which keeps the microseconds a JS
 * `Date` would drop (see `FollowingCursorPosition`). The colons are quoted
 * literals inside the pattern (`":"`) because TypeORM scans query text for
 * `:name` and would splice a bound value into a bare `:MI` the day a
 * parameter of that name joined the query.
 */
export const FOLLOWING_CURSOR_TIMESTAMP_SQL = `to_char("sf"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":"MI":"SS.US"Z"')`;

/** Opaque to the client: base64url of `<followedAt>|<followId>`. */
export function encodeFollowingCursor(
  position: FollowingCursorPosition,
): string {
  return Buffer.from(
    `${position.followedAt}${CURSOR_SEPARATOR}${position.followId}`,
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a `before` cursor, or throws a 400 carrying
 * `FOLLOWING_CURSOR_INVALID`. A malformed cursor is refused outright: quietly
 * serving page 1 would hand the client rows it already shows, and letting it
 * reach the query would turn a bad string into a 500.
 */
export function decodeFollowingCursor(cursor: string): FollowingCursorPosition {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = decoded.split(CURSOR_SEPARATOR);
  const [followedAt = '', followId = ''] = parts;
  const isWellFormed =
    parts.length === 2 &&
    MICROSECOND_UTC_TIMESTAMP.test(followedAt) &&
    isRealCalendarInstant(followedAt) &&
    UUID_PATTERN.test(followId);
  if (!isWellFormed) {
    throw new BadRequestException({
      code: FOLLOWING_CURSOR_INVALID_CODE,
      message: 'The following list cursor is malformed',
    });
  }
  return { followedAt, followId };
}

// The regex accepts "2026-02-30" and "24:00", which `Date.parse` rolls over
// into the next day while Postgres refuses the cast with a 500. Formatting the
// parsed instant back and comparing it to the input, down to the millisecond,
// rejects every such string. Instants before 1970 are refused too: no follow
// predates the epoch, and Postgres refuses year 0 outright.
function isRealCalendarInstant(timestamp: string): boolean {
  const parsedMilliseconds = Date.parse(timestamp);
  if (Number.isNaN(parsedMilliseconds) || parsedMilliseconds < 0) return false;
  const millisecondPrefixLength = 'YYYY-MM-DDTHH:MM:SS.mmm'.length;
  return (
    new Date(parsedMilliseconds)
      .toISOString()
      .slice(0, millisecondPrefixLength) ===
    timestamp.slice(0, millisecondPrefixLength)
  );
}
