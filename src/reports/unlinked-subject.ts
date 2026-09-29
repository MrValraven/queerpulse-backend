import { randomUUID } from 'crypto';
import { ReportSubjectType } from './entities/report.entity';

/**
 * Subject ids for a report that names no record (ENG-483).
 *
 * The public `/safety/report` form has no subject picker: the reporter
 * describes the person or the place in prose, and the report is filed as a
 * `member` or `venue` subject with nothing to point at. It used to send one
 * fixed sentinel, `"unspecified"`, for every such filing. That single id meant
 * every public report on the platform shared one subject, so the open-report
 * dedupe collapsed a member's unrelated incidents into one row, the
 * per-subject flood cap refused a legitimate fourth report in a week, the
 * moderation queue clustered strangers' reports into one pile-on, and the
 * prior-report counts inflated for a subject that is nobody. Worse, the
 * sentinel was a valid handle, so a member who claimed `unspecified` would
 * have become the resolved subject of all of it.
 *
 * Each incident now carries its own id, `unlinked:<uuid>`. The client mints it
 * once per draft, so a double tap or a retry of the same draft reuses it and
 * still dedupes, and a genuinely new incident gets a fresh one. The colon can
 * never appear in a handle (`HANDLE_RE` in `common/handles.ts`), so an unlinked
 * id can never resolve to a member.
 */
export const UNLINKED_SUBJECT_PREFIX = 'unlinked:';

/**
 * The single shared sentinel older clients still send. `ReportsService.create`
 * rewrites it to a freshly minted unlinked id, so a stale client loses only its
 * double-submit idempotency. `'unspecified'` is also a reserved handle now.
 */
export const LEGACY_UNLINKED_SUBJECT_ID = 'unspecified';

/** The only subject types the public form files, and so the only ones an
 *  unlinked id may be filed under. */
export const UNLINKED_SUBJECT_TYPES: readonly ReportSubjectType[] = [
  ReportSubjectType.Member,
  ReportSubjectType.Venue,
];

/** A well-formed unlinked id: the prefix followed by a uuid. */
export const UNLINKED_SUBJECT_RE = /^unlinked:[0-9a-f-]{36}$/i;

/**
 * True when `subjectId` claims to be an unlinked id, well-formed or not. The
 * prefix is matched case-insensitively so an `UNLINKED:` spelling is caught by
 * the same validation and cannot slip past it as an ordinary id.
 */
export function isUnlinkedSubjectId(subjectId: string): boolean {
  return subjectId.toLowerCase().startsWith(UNLINKED_SUBJECT_PREFIX);
}

/** A fresh unlinked id, for a filing whose client could not mint its own. */
export function mintUnlinkedSubjectId(): string {
  return `${UNLINKED_SUBJECT_PREFIX}${randomUUID()}`;
}
