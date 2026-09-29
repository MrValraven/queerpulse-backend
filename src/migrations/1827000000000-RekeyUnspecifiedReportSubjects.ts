// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every past public-form report its own subject id (ENG-483).
 *
 * The public `/safety/report` form used to file every report under one shared
 * subject id, `"unspecified"`, as a `member` or a `venue` subject. New filings
 * now carry `unlinked:<uuid>`, one per incident (`reports/unlinked-subject.ts`).
 * The rows filed before that still share the one id, so the moderation queue
 * clusters strangers' unrelated reports into one pile-on, the prior-report
 * counts inflate for a subject that is nobody, and a member who ever held the
 * handle `unspecified` would resolve as the subject of all of them. This gives
 * each of those rows a fresh unlinked id of its own.
 *
 * DATA ONLY, and `gen_random_uuid()` is evaluated per row, so every row gets a
 * distinct id. The open-report dedupe index
 * (`UQ_reports_open_reporter_subject`) cannot conflict: no two rewritten rows
 * share a subject id, and no existing row carries an `unlinked:` id the
 * rewrite could collide with.
 *
 * Scoped to `member` and `venue`, the only subject types the public form
 * filed. An `"unspecified"` on any other subject type came from somewhere
 * else and is left exactly as it is.
 *
 * `down` is a documented no-op: the rewrite is not reversible in any useful
 * sense. Collapsing the rows back onto one shared id would restore the very
 * pooling this removes, and nothing records which rows were rewritten beyond
 * the `unlinked:` shape, which new filings share. A silent no-op is safe here
 * where an enum `ADD VALUE` is not: after a revert, re-running `up` finds no
 * `"unspecified"` member or venue rows left (the server now mints an id for
 * any stale client that still sends it) and updates nothing.
 */
export class RekeyUnspecifiedReportSubjects1827000000000 implements MigrationInterface {
  name = 'RekeyUnspecifiedReportSubjects1827000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "reports"
      SET "subject_id" = 'unlinked:' || gen_random_uuid()::text
      WHERE "subject_id" = 'unspecified'
        AND "subject_type" IN ('member', 'venue')
    `);
  }

  public async down(): Promise<void> {
    // Intentionally empty. See the class comment for why the rewrite is not
    // reversed.
  }
}
