// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Run by" on gatherings (`QUEERPULSE-NO-FIXED-PREMISES-DESIGN-2026-10-08.md`,
 * section 6): the directory listing whose business runs a gathering,
 * independent of the venue `listing_id`. Runs after
 * `AddListingMobile1830400000000`.
 *
 * `ON DELETE SET NULL`, the same rule as the venue link
 * (`AddEventListingLink1782800870000`): deleting a listing unlinks its
 * gatherings and leaves them standing.
 *
 * The index is partial: most gatherings name no business, and both readers
 * (the listing's Upcoming block and the clearing pass when someone stops
 * managing a listing) look up non-null values only. The column is new and
 * NULL on every row, so the build is quick and runs inside the migration's
 * transaction.
 */
export class AddEventRunByListing1830400100000 implements MigrationInterface {
  name = 'AddEventRunByListing1830400100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ADD "run_by_listing_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ADD CONSTRAINT "FK_events_run_by_listing_id" FOREIGN KEY ("run_by_listing_id") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_events_run_by_listing_id" ON "events" ("run_by_listing_id") WHERE "run_by_listing_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_events_run_by_listing_id"`);
    await queryRunner.query(
      `ALTER TABLE "events" DROP CONSTRAINT "FK_events_run_by_listing_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN "run_by_listing_id"`,
    );
  }
}
