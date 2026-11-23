import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * SEC-31, the part SQL can decide, shared by every staff reader of
 * `mod_audit_logs` (the governance audit feed, its CSV, and the platform log):
 * a row decided on a report that names the viewer as its target (a sanction
 * on them), and every row on a `member` report filed against the viewer by
 * user id or profile slug. Report-less rows about the viewer (a role change,
 * a lifted suspension) stay: they are no report's case. Every use of the one
 * bound parameter is cast to `uuid`, because Postgres deduces a single type
 * per parameter.
 *
 * `alias` is the query builder's alias for `ModAuditLog`; the conditions use
 * entity property paths, which TypeORM rewrites to that alias's columns.
 * The rows this cannot see (a report about content the viewer authored) are
 * the caller's to drop through `ModerationService.reportIdsAboutActor`.
 */
export function excludeAuditRowsAboutViewer<Entity extends ObjectLiteral>(
  builder: SelectQueryBuilder<Entity>,
  alias: string,
  viewerUserId: string,
): SelectQueryBuilder<Entity> {
  return (
    builder
      .andWhere(
        `(${alias}.reportId IS NULL OR ${alias}.targetUserId IS NULL OR ${alias}.targetUserId <> CAST(:viewerUserId AS uuid))`,
        { viewerUserId },
      )
      .andWhere(
        `(${alias}.reportId IS NULL OR ${alias}.reportId NOT IN (
           SELECT viewer_report.id FROM reports viewer_report
            WHERE viewer_report.subject_type = 'member'
              AND (lower(viewer_report.subject_id) = CAST(:viewerUserId AS uuid)::text
                OR viewer_report.subject_id IN (
                  SELECT viewer_profile.slug FROM profiles viewer_profile
                   WHERE viewer_profile.user_id = CAST(:viewerUserId AS uuid))))
         )`,
        { viewerUserId },
      )
      // A citation (`evidence_cited`, the trust-network inspector's Cite
      // action) is report-less and still the case being built against the
      // member it targets, so the viewer's own citations stay out too.
      // Written NULL-safe: a row with no target is kept.
      .andWhere(
        `(${alias}.action <> 'evidence_cited' OR ${alias}.targetUserId IS NULL OR ${alias}.targetUserId <> CAST(:viewerUserId AS uuid))`,
        { viewerUserId },
      )
  );
}
