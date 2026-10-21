import { Paginated } from '../common/pagination';
import { SavedItem } from './entities/saved-item.entity';
import { SavedRef, parseSavedRef, toSavedId } from './saved-ref.util';
import { ResolvedSavedItemDTO } from './saved-response';

/*
 * ENG-04: `GET /me/saved?kind=&cursor=` walks one kind past its first page
 * without the drift an OFFSET has when the member unsaves something between
 * two reads. The cursor names the last item a page returned by its save
 * time and its composite ref (the same `<kind>:<subjectId>` id the client
 * already holds), so it carries no row id.
 */

/** The `{items,total,page,pageSize}` envelope plus the next page's cursor,
 *  null on the last page. `total` always counts the whole filtered set. */
export type SavedPage = Paginated<ResolvedSavedItemDTO> & {
  nextCursor: string | null;
};

/** Where the next page starts: the last item of the page before it. */
export interface SavedCursor {
  savedAt: Date;
  ref: SavedRef;
}

export function encodeSavedCursor(row: SavedItem): string {
  return Buffer.from(
    `${row.createdAt.toISOString()}|${toSavedId(row.subjectType, row.subjectId)}`,
    'utf8',
  ).toString('base64url');
}

/** The exact shape `toISOString` writes for a year from 0001 to 9999.
 *  Anything else (an extended year, year 0000, a bare date) never reaches
 *  the `timestamptz` cast, where Postgres would reject it with a 500. */
const SAVED_AT_PATTERN = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseSavedAt(savedAtText: string): Date | null {
  const match = SAVED_AT_PATTERN.exec(savedAtText);
  if (!match || Number(match[1]) < 1) {
    return null;
  }
  const savedAt = new Date(savedAtText);
  return Number.isNaN(savedAt.getTime()) ? null : savedAt;
}

/** Never throws: anything malformed reads as "no cursor" (the first page). */
export function decodeSavedCursor(
  cursor: string | undefined,
): SavedCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex <= 0) {
    return null;
  }
  const savedAt = parseSavedAt(decoded.slice(0, separatorIndex));
  if (!savedAt) {
    return null;
  }
  try {
    return { savedAt, ref: parseSavedRef(decoded.slice(separatorIndex + 1)) };
  } catch {
    return null;
  }
}

/**
 * The keyset predicate: rows strictly after the cursor item in
 * `(created_at desc, id desc)` order. The cursor item's own row supplies the
 * exact microsecond position. When the member unsaved it since, the page
 * falls back to its save time rounded up a millisecond, so a neighbour saved
 * in that same millisecond may repeat (the client removes duplicates by id) and is never
 * skipped.
 */
export const SAVED_AFTER_CURSOR_SQL = `(
  ("saved"."created_at", "saved"."id") < (
    SELECT "cursor_item"."created_at", "cursor_item"."id"
      FROM "saved_item" "cursor_item"
     WHERE "cursor_item"."user_id" = :userId
       AND "cursor_item"."subject_type" = :cursorSubjectType
       AND "cursor_item"."subject_id" = :cursorSubjectId
  )
  OR (
    NOT EXISTS (
      SELECT 1
        FROM "saved_item" "cursor_item"
       WHERE "cursor_item"."user_id" = :userId
         AND "cursor_item"."subject_type" = :cursorSubjectType
         AND "cursor_item"."subject_id" = :cursorSubjectId
    )
    AND "saved"."created_at" < CAST(:cursorSavedAt AS timestamptz) + INTERVAL '1 millisecond'
  )
)`;

export function savedCursorParameters(cursor: SavedCursor): {
  cursorSubjectType: string;
  cursorSubjectId: string;
  cursorSavedAt: string;
} {
  return {
    cursorSubjectType: cursor.ref.subjectType,
    cursorSubjectId: cursor.ref.subjectId,
    cursorSavedAt: cursor.savedAt.toISOString(),
  };
}
