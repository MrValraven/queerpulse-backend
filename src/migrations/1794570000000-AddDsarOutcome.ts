import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives a data-subject request somewhere to land (ID-04).
 *
 * `POST /account/dsar` has always written a `dsar_request` row with a 30-day
 * statutory `due_by`, but no surface listed, reviewed or resolved one, so
 * `status` never left `received` and the deadline ran unseen. The new
 * `src/admin-dsar` module is that surface, and it needs two things this
 * migration adds:
 *
 *  - `outcome_note`: what the reviewing operator decided, in their own words.
 *    Required before a request can be closed (`AdminDsarService.update`), so a
 *    resolved/rejected row always records what was actually done.
 *  - `resolved_by_user_id`: who closed it. `ON DELETE SET NULL`, never
 *    CASCADE: losing the reviewer's account must not delete the record of a
 *    statutory request being answered.
 *
 * Plus the composite index the queue's only sort needs. The queue reads
 * "open requests, closest deadline first", i.e. `WHERE status = $1 ORDER BY
 * due_by ASC`, so `(status, due_by)` serves both the filter and the ordering
 * from one index, and the unfiltered "all" tab still walks it in `due_by`
 * order for the leading-column-free scan.
 */
export class AddDsarOutcome1794570000000 implements MigrationInterface {
  name = 'AddDsarOutcome1794570000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dsar_request" ADD COLUMN "outcome_note" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "dsar_request" ADD COLUMN "resolved_by_user_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "dsar_request"
      ADD CONSTRAINT "FK_dsar_request_resolved_by_user_id"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_dsar_request_status_due_by" ON "dsar_request" ("status", "due_by")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_dsar_request_status_due_by"`);
    await queryRunner.query(
      `ALTER TABLE "dsar_request" DROP CONSTRAINT "FK_dsar_request_resolved_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dsar_request" DROP COLUMN "resolved_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dsar_request" DROP COLUMN "outcome_note"`,
    );
  }
}
