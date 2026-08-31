import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Narrows `reports.created_at` and `reports.sla_due_at` from Postgres's
 * default `timestamptz` (microsecond precision) to `timestamptz(3)`, and adds
 * the two ascending `(column, id)` indexes the moderation queue's `sort`
 * parameter now pages on.
 *
 * `GET /mod/reports?sort=priority|age` was validated by the DTO and then
 * never read by the service — every listing came back newest-first however it
 * was asked for, so the queue could not be ordered by the SLA the
 * "emergency within 1h" policy is written against, and the UI control was a
 * no-op (BE-COM-11). Honouring it means paging on a column other than
 * `created_at DESC`, which goes through `cursorPaginate`'s alternate-keyset
 * path — and that path uses the RAW column, with a millisecond-resolution JS
 * `Date` cursor.
 *
 * That is exactly why the precision has to come down first. A row stored at
 * `12:00:00.123456` compared against a cursor serialised as `12:00:00.123`
 * still satisfies `col > cursor`, so it would be served again on the next
 * page — a duplicate at every page boundary. Once the column itself is
 * `timestamptz(3)`, Postgres rounds at write time and the raw column matches
 * the cursor's resolution exactly. Same reasoning, same fix, as
 * `1785001400000-NarrowCursorCreatedAtPrecision` for the feed/forum/event
 * cursors — see that migration for the full write-up, including why a
 * functional `date_trunc` index is not an option.
 *
 * LOCK CAVEAT: `ALTER COLUMN ... TYPE timestamptz(3)` is a narrowing cast, so
 * Postgres rewrites the table under an ACCESS EXCLUSIVE lock. `reports` is
 * small at this project's scale, but run it in a low-traffic window. The two
 * indexes are created in this same transactional migration rather than
 * `CONCURRENTLY` in a separate file precisely BECAUSE the rewrite above
 * already holds that lock — a concurrent build would buy nothing here.
 *
 * No existing row's relative order changes: rounding microseconds to
 * milliseconds can only make same-millisecond rows compare equal, which is
 * the case the `id` tie-break in every keyset already disambiguates.
 */
export class NarrowReportCursorPrecision1793520300000 implements MigrationInterface {
  name = 'NarrowReportCursorPrecision1793520300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reports" ALTER COLUMN "created_at" TYPE timestamptz(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ALTER COLUMN "sla_due_at" TYPE timestamptz(3)`,
    );
    // `sort=priority` — soonest-due first. `sla_due_at` is derived from
    // `severity` at creation (emergency = +1h, low = days), so ordering by it
    // IS severity-then-age ordering, without a non-indexable CASE expression.
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_sla_due_at_id" ON "reports" ("sla_due_at" ASC, "id" ASC)`,
    );
    // `sort=age` — oldest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_created_at_id" ON "reports" ("created_at" ASC, "id" ASC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_reports_created_at_id"`);
    await queryRunner.query(`DROP INDEX "IDX_reports_sla_due_at_id"`);
    await queryRunner.query(
      `ALTER TABLE "reports" ALTER COLUMN "sla_due_at" TYPE timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ALTER COLUMN "created_at" TYPE timestamptz`,
    );
  }
}
