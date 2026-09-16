/**
 * Opaque keyset cursor for thread history (`GET /conversations/:id/messages`).
 *
 * Why messaging has its own codec instead of `common/cursor-pagination.ts`:
 * `messages.created_at` is a plain `timestamptz` written by `DEFAULT now()`, so
 * Postgres stores MICROSECONDS, while the shared `encodeCursor` serializes a JS
 * `Date` (milliseconds). A boundary row at `.123456` becomes a cursor of
 * `.123`, and the strict `(created_at, id) < (cursor)` predicate then treats
 * every older row in `[.123000, .123456)` as newer than the cursor, so those
 * rows are skipped and never appear on any page. This cursor instead carries
 * the exact timestamp text Postgres itself produced (see
 * `EXACT_CREATED_AT_SELECT`), which casts back to the identical instant, so the
 * raw, index-friendly tuple predicate stays exact.
 *
 * The wire format (`<ISO timestamp>|<uuid>`, base64) is the same shape the
 * shared codec emits, so a millisecond cursor from `encodeCursor` still decodes
 * here.
 */

/**
 * Selects `m.created_at` as UTC ISO-8601 text at full microsecond precision.
 * `AT TIME ZONE 'UTC'` pins the rendering regardless of the session TimeZone.
 */
export const EXACT_CREATED_AT_SELECT = `to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const EXACT_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeMessageHistoryCursor(
  exactCreatedAt: string,
  id: string,
): string {
  return Buffer.from(`${exactCreatedAt}|${id}`).toString('base64');
}

/**
 * Decodes a history cursor into the `before`/`beforeId` pair the keyset
 * predicate binds. Never throws: anything malformed resolves to `null` (first
 * page). Both halves are validated here because they are cast with
 * `::timestamptz` and `::uuid` in SQL, where a forged value would otherwise
 * surface as a 500 instead of a harmless first page.
 */
export function decodeMessageHistoryCursor(
  cursor: string,
): { before: string; beforeId: string } | null {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex === -1) return null;

  const before = decoded.slice(0, separatorIndex);
  const beforeId = decoded.slice(separatorIndex + 1);
  if (!EXACT_TIMESTAMP_PATTERN.test(before) || !UUID_PATTERN.test(beforeId)) {
    return null;
  }
  // Reject calendar-impossible dates (e.g. Feb 30, 24:00:00) that the pattern
  // admits: JS rolls them over, so the round-tripped seconds no longer match.
  // Year 0000 round-trips in JS but Postgres rejects it as out of range.
  const parsed = new Date(before);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() < 1 ||
    parsed.toISOString().slice(0, 19) !== before.slice(0, 19)
  ) {
    return null;
  }
  return { before, beforeId };
}
