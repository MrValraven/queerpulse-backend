// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-446: persona takedowns are keyed on the persona uuid.
 *
 * The persona page reports with the persona's uuid, and
 * `ModerationService` stores a takedown under `report.subjectId`, so a
 * moderator's `hide_content`/`remove_content` has always written a
 * `content_moderation` row with `subject_id = <persona uuid>`. Every persona
 * read and write gate looked the state up by `subprofiles.slug`, so those
 * takedowns never took effect. The gates now read `subprofiles.id` (see
 * `src/subprofiles/subprofile-takedown.ts`). This migration moves the older
 * rows that were keyed by slug, so none of them loses its effect.
 *
 * Table shape it works with: `content_moderation` has one unique index,
 * `UQ_content_moderation_subject` on `(subject_type, subject_id)`, plus the
 * uuid primary key. `subject_id` is varchar. So each persona can hold one row,
 * and a rekeyed row that lands on a persona already holding a uuid-keyed row
 * has to merge into it.
 *
 * Each persona row (`subject_type = 'subprofile'`) whose `subject_id` is not
 * a uuid is a slug-keyed row. Its target persona or personas:
 * 1. Its `report_id` names a `subprofile` report whose `subject_id` is the
 *    uuid of a persona that still exists: that persona, alone.
 * 2. Otherwise every persona whose `slug` equals the row's `subject_id`. A
 *    slug is unique per creator only, so several personas can share it; each
 *    of them gets its own row. That keeps what the slug key did until now (it
 *    withheld all of them), and a moderator can lift each one separately.
 * 3. Otherwise (no persona holds that slug any more) the row is kept as it
 *    is. It no longer withholds anything, and no row is ever deleted without
 *    a replacement.
 *
 * All the rows landing on one persona, plus any uuid-keyed row it already
 * holds, merge into one row: each timestamp takes the earliest value set on
 * any of them (`hidden_at`, `removed_at`, `created_at`), so a removal beats a
 * hide and the merge can only keep the persona withheld. The moderator, report,
 * reason and note come from the strongest row (removed, then hidden, then
 * lifted), the earliest among equals; an existing uuid-keyed row keeps its own
 * unless an incoming row is strictly stronger. Every slug-keyed row that
 * produced at least one replacement is then deleted, in the same statement.
 *
 * `up` logs how many rows it wrote and deleted, so the deploy log records the
 * move.
 *
 * `down` is a no-op: the slug key was the defect, and the uuid-keyed rows are
 * the ones today's code reads. A slug-keyed row cannot be rebuilt from a
 * merged uuid-keyed row anyway.
 */
const PERSONA_SUBJECT_TYPE = 'subprofile';
const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

// The one row `up` reads back: how many rows each path touched.
interface RekeyTally {
  slugKeyedCount: number;
  byReportCount: number;
  bySlugCount: number;
  writtenCount: number;
  deletedCount: number;
}

// 2 for removed, 1 for hidden, 0 for a lifted row with neither stamp.
function strengthOf(rowAlias: string): string {
  return `(CASE WHEN ${rowAlias}."removed_at" IS NOT NULL THEN 2 WHEN ${rowAlias}."hidden_at" IS NOT NULL THEN 1 ELSE 0 END)`;
}

// On a merge into an existing uuid-keyed row, `column` takes the incoming
// value only when the incoming row is strictly stronger.
function takeFromStronger(column: string): string {
  return `"${column}" = CASE WHEN ${strengthOf('EXCLUDED')} > ${strengthOf('"content_moderation"')} THEN EXCLUDED."${column}" ELSE "content_moderation"."${column}" END`;
}

export class RekeyPersonaTakedownsToId1824700000000 implements MigrationInterface {
  name = 'RekeyPersonaTakedownsToId1824700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `
      WITH "slug_keyed" AS (
        SELECT "cm".*
          FROM "content_moderation" "cm"
         WHERE "cm"."subject_type" = $1
           AND "cm"."subject_id" !~* $2
      ),
      "by_report" AS (
        SELECT "slug_keyed"."id" AS "source_id", "persona"."id" AS "target_id"
          FROM "slug_keyed"
          JOIN "reports" "report"
            ON "report"."id" = "slug_keyed"."report_id"
           AND "report"."subject_type"::text = $1
          JOIN "subprofiles" "persona"
            ON "persona"."id"::text = lower("report"."subject_id")
      ),
      "by_slug" AS (
        SELECT "slug_keyed"."id" AS "source_id", "persona"."id" AS "target_id"
          FROM "slug_keyed"
          JOIN "subprofiles" "persona"
            ON "persona"."slug" = "slug_keyed"."subject_id"
         WHERE NOT EXISTS (
                 SELECT 1 FROM "by_report"
                  WHERE "by_report"."source_id" = "slug_keyed"."id"
               )
      ),
      "mapping" AS (
        SELECT "source_id", "target_id" FROM "by_report"
        UNION ALL
        SELECT "source_id", "target_id" FROM "by_slug"
      ),
      "sources" AS (
        SELECT "mapping"."target_id", "slug_keyed".*
          FROM "mapping"
          JOIN "slug_keyed" ON "slug_keyed"."id" = "mapping"."source_id"
      ),
      "merged" AS (
        SELECT DISTINCT ON ("sources"."target_id")
               "sources"."target_id",
               min("sources"."hidden_at") OVER "per_target" AS "hidden_at",
               min("sources"."removed_at") OVER "per_target" AS "removed_at",
               min("sources"."created_at") OVER "per_target" AS "created_at",
               "sources"."moderated_by",
               "sources"."report_id",
               "sources"."reason_code",
               "sources"."note"
          FROM "sources"
        WINDOW "per_target" AS (PARTITION BY "sources"."target_id")
         ORDER BY "sources"."target_id",
                  ${strengthOf('"sources"')} DESC,
                  coalesce("sources"."removed_at", "sources"."hidden_at", "sources"."created_at") ASC,
                  "sources"."id" ASC
      ),
      "written" AS (
        INSERT INTO "content_moderation"
               ("subject_type", "subject_id", "hidden_at", "removed_at",
                "moderated_by", "report_id", "reason_code", "note",
                "created_at", "updated_at")
        SELECT $1::varchar, "merged"."target_id"::text, "merged"."hidden_at",
               "merged"."removed_at", "merged"."moderated_by",
               "merged"."report_id", "merged"."reason_code", "merged"."note",
               "merged"."created_at", now()
          FROM "merged"
        ON CONFLICT ("subject_type", "subject_id")
        DO UPDATE SET
          ${takeFromStronger('moderated_by')},
          ${takeFromStronger('report_id')},
          ${takeFromStronger('reason_code')},
          ${takeFromStronger('note')},
          "hidden_at" = least("content_moderation"."hidden_at", EXCLUDED."hidden_at"),
          "removed_at" = least("content_moderation"."removed_at", EXCLUDED."removed_at"),
          "created_at" = least("content_moderation"."created_at", EXCLUDED."created_at"),
          "updated_at" = now()
        RETURNING 1
      ),
      "deleted" AS (
        DELETE FROM "content_moderation"
         WHERE "id" IN (SELECT "source_id" FROM "mapping")
        RETURNING 1
      )
      SELECT
        (SELECT count(*)::int FROM "slug_keyed") AS "slugKeyedCount",
        (SELECT count(DISTINCT "source_id")::int FROM "by_report") AS "byReportCount",
        (SELECT count(DISTINCT "source_id")::int FROM "by_slug") AS "bySlugCount",
        (SELECT count(*)::int FROM "written") AS "writtenCount",
        (SELECT count(*)::int FROM "deleted") AS "deletedCount"
      `,
      [PERSONA_SUBJECT_TYPE, UUID_PATTERN],
    )) as RekeyTally[];
    const tally = rows[0];
    // The one record of how many slug-keyed persona takedowns were moved.
    console.log(
      `[RekeyPersonaTakedownsToId] slug-keyed rows ${tally?.slugKeyedCount ?? 0}: ` +
        `${tally?.byReportCount ?? 0} rekeyed through their report, ` +
        `${tally?.bySlugCount ?? 0} through the slug, ` +
        `${tally?.writtenCount ?? 0} uuid-keyed row(s) written or merged, ` +
        `${tally?.deletedCount ?? 0} slug-keyed row(s) deleted`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: see the class comment.
  }
}
