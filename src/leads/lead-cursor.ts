import { leadError } from './leads.constants';

/**
 * Upper bound for the raw `cursor` query string. A real cursor is at most 122
 * characters (base64url of a 91-character position); the bound leaves
 * headroom while refusing a payload large enough to be worth decoding.
 */
export const LEAD_CURSOR_MAX_LENGTH = 200;

/**
 * The position of one row in the leads list, whose order is
 * `due_rank ASC, due_on ASC NULLS LAST, updated_at DESC, id DESC`.
 *
 * `today` is the Lisbon calendar day the first page was read on. A later page
 * binds it as the day of the read, so a page read after Lisbon midnight keeps
 * the due ranks the first page used and skips no row.
 *
 * `dueOn` is the follow-up day when `dueRank` is 0, and `null` when it is 1.
 *
 * `updatedAt` is the timestamp as Postgres rendered it, in UTC with all six
 * fractional digits (`2026-11-05T12:00:00.123456Z`). It is carried as text on
 * purpose: `updated_at` holds microseconds and a JS `Date` holds milliseconds,
 * so a cursor rebuilt from a `Date` would sit up to a millisecond away from
 * the real row, and every lead saved inside that millisecond after it would
 * be skipped by the `<` comparison.
 */
export interface LeadCursorPosition {
  today: string;
  dueRank: 0 | 1;
  dueOn: string | null;
  updatedAt: string;
  leadId: string;
}

const CURSOR_VERSION = 'v1';
const CURSOR_SEPARATOR = '|';
const CURSOR_PART_COUNT = 6;
/** Stands for the missing `dueOn` of a rank 1 position. */
const NO_DUE_ON = '-';
const CALENDAR_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MICROSECOND_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SQL that renders `updated_at` in the exact shape `decodeLeadCursor`
 * accepts. Postgres renders the text, which keeps the microseconds a JS
 * `Date` would drop (see `LeadCursorPosition`). The colons are quoted
 * literals inside the pattern (`":"`) because TypeORM scans query text for
 * `:name` and would splice a bound value into a bare `:MI` the day a
 * parameter of that name joined the query.
 */
export const LEAD_CURSOR_UPDATED_AT_SQL = `to_char("lead"."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":"MI":"SS.US"Z"')`;

/** Opaque to the client: base64url of
 *  `v1|<today>|<dueRank>|<dueOn or ->|<updatedAt>|<leadId>`. */
export function encodeLeadCursor(position: LeadCursorPosition): string {
  return Buffer.from(
    [
      CURSOR_VERSION,
      position.today,
      String(position.dueRank),
      position.dueOn ?? NO_DUE_ON,
      position.updatedAt,
      position.leadId,
    ].join(CURSOR_SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a list cursor, or throws a 400 carrying `LEAD_CURSOR_INVALID`. A
 * malformed cursor is refused outright: quietly serving page 1 would hand the
 * client rows it already shows, and letting it reach the query would turn a
 * bad string into a Postgres cast error and a 500.
 */
export function decodeLeadCursor(cursor: string): LeadCursorPosition {
  if (cursor.length > LEAD_CURSOR_MAX_LENGTH) {
    throw leadError('LEAD_CURSOR_INVALID');
  }
  const parts = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split(CURSOR_SEPARATOR);
  if (parts.length !== CURSOR_PART_COUNT) {
    throw leadError('LEAD_CURSOR_INVALID');
  }
  const [
    version = '',
    today = '',
    dueRankText = '',
    dueOnText = '',
    updatedAt = '',
    leadId = '',
  ] = parts;
  const isDueRankValid = dueRankText === '0' || dueRankText === '1';
  const hasDueOn = dueRankText === '0';
  const isDueOnValid = hasDueOn
    ? isRealCalendarDay(dueOnText)
    : dueOnText === NO_DUE_ON;
  const isWellFormed =
    version === CURSOR_VERSION &&
    isRealCalendarDay(today) &&
    isDueRankValid &&
    isDueOnValid &&
    MICROSECOND_UTC_TIMESTAMP.test(updatedAt) &&
    isRealCalendarInstant(updatedAt) &&
    UUID_PATTERN.test(leadId);
  if (!isWellFormed) {
    throw leadError('LEAD_CURSOR_INVALID');
  }
  return {
    today,
    dueRank: hasDueOn ? 0 : 1,
    dueOn: hasDueOn ? dueOnText : null,
    updatedAt,
    leadId,
  };
}

/**
 * Whether `value` is a real `YYYY-MM-DD` day. The pattern accepts
 * `2026-02-30`, which `Date` rolls over into March while Postgres refuses the
 * cast with a 500, so the parsed day is formatted back and compared with the
 * input. Year 0000 is refused as well: Postgres has no year zero.
 */
export function isRealCalendarDay(value: string): boolean {
  if (!CALENDAR_DAY_PATTERN.test(value) || value.startsWith('0000')) {
    return false;
  }
  const parsedDay = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsedDay.getTime())) return false;
  return parsedDay.toISOString().slice(0, 10) === value;
}

// The regex accepts "2026-02-30" and "24:00", which `Date.parse` rolls over
// into the next day while Postgres refuses the cast with a 500. Formatting the
// parsed instant back and comparing it to the input, down to the millisecond,
// rejects every such string. Instants before 1970 are refused too: no lead
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
