import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TS-11. Gives `appeals` the two timestamps the Code of Conduct §05 already
 * promises in prose: when an appeal is due to be decided, and when it actually
 * was.
 *
 * `sla_due_at` mirrors `reports.sla_due_at` exactly, including its precision:
 * the awaiting queue pages on this raw column through `cursorPaginate`'s
 * alternate-keyset path, which compares a millisecond-resolution JS `Date`
 * cursor against the stored value. A `timestamptz` at Postgres's default
 * microsecond precision would re-serve the boundary row on every page (see
 * `1793520300000-NarrowReportCursorPrecision` for the full argument). Same
 * reason `created_at` comes down to `timestamptz(3)` here: the DECIDED tab
 * pages on the default `(created_at, id) DESC` keyset, and that can only drop
 * its non-indexable `date_trunc('milliseconds', ...)` wrapper once the column
 * itself is millisecond-precision.
 *
 * BACKFILL, and why each column gets a different answer:
 *
 *  - `sla_due_at` is backfilled for EVERY existing row as `created_at + 7
 *    days`, then made NOT NULL. This is the published window applied
 *    retroactively, which is the honest reading: those appeals were always
 *    covered by §05, nothing was ever recording it. It also has to be NOT
 *    NULL, because a keyset tuple comparison against a NULL evaluates to NULL
 *    and would silently drop those rows out of every page of the queue they
 *    belong in.
 *  - `decided_at` is deliberately NOT backfilled. An appeal decided before this
 *    column existed has no recoverable decision timestamp; reconstructing one
 *    from `mod_audit_logs` would miss every cold appeal (no `report_id` means
 *    no `appeal_upheld`/`appeal_overturned` row) and would quietly invent a
 *    turnaround statistic out of a partial sample. NULL on a decided row means
 *    "decided, time unrecorded", which is true.
 *
 * The two ascending/descending `(column, id)` indexes are the ones the two
 * queue tabs page on.
 *
 * LOCK CAVEAT: `ALTER COLUMN ... TYPE timestamptz(3)` on `created_at` is a
 * narrowing cast, so Postgres rewrites the table under an ACCESS EXCLUSIVE
 * lock. `appeals` is small at this project's scale. The indexes are built in
 * this same transactional migration rather than `CONCURRENTLY` in a separate
 * file precisely BECAUSE the rewrite already holds that lock, so a concurrent
 * build would buy nothing.
 */
export class AddAppealDecisionWindows1794920000000 implements MigrationInterface {
  name = 'AddAppealDecisionWindows1794920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "appeals" ALTER COLUMN "created_at" TYPE timestamptz(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "appeals" ADD COLUMN "sla_due_at" timestamptz(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "appeals" ADD COLUMN "decided_at" timestamptz(3)`,
    );
    // The published 7-day window, applied retroactively to rows filed before
    // anything recorded it. Runs before the NOT NULL below so no row is left
    // behind for the keyset to trip over.
    await queryRunner.query(
      `UPDATE "appeals" SET "sla_due_at" = "created_at" + interval '7 days' WHERE "sla_due_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "appeals" ALTER COLUMN "sla_due_at" SET NOT NULL`,
    );
    // The AWAITING tab: soonest-due first, which is also what makes "overdue"
    // a range scan rather than a sequential one.
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_sla_due_at_id" ON "appeals" ("sla_due_at" ASC, "id" ASC)`,
    );
    // The DECIDED tab pages on `(created_at, id) DESC`.
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_created_at_id" ON "appeals" ("created_at" DESC, "id" DESC)`,
    );
    // Read alongside the row by the transparency figures rather than paged on,
    // so a plain single-column index is enough.
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_decided_at" ON "appeals" ("decided_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_appeals_decided_at"`);
    await queryRunner.query(`DROP INDEX "IDX_appeals_created_at_id"`);
    await queryRunner.query(`DROP INDEX "IDX_appeals_sla_due_at_id"`);
    await queryRunner.query(`ALTER TABLE "appeals" DROP COLUMN "decided_at"`);
    await queryRunner.query(`ALTER TABLE "appeals" DROP COLUMN "sla_due_at"`);
    await queryRunner.query(
      `ALTER TABLE "appeals" ALTER COLUMN "created_at" TYPE timestamptz`,
    );
  }
}
