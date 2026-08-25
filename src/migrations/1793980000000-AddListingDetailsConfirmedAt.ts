import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.details_confirmed_at`: when the owner last asserted that the
 * listing's details are still true.
 *
 * Nothing on a listing said when any of it was last true. `updated_at` cannot
 * answer that question honestly, because any write moves it, including
 * moderator-only ones the owner never saw (a safe-space toggle, a queer-owned
 * confirmation, a status change). This column is moved by exactly two things:
 * the owner pressing "still accurate"
 * (`POST /listings/:ref/confirm-details`), and the owner making an edit that
 * actually changed something, on the principle that editing your details is
 * confirming them.
 *
 * Backfilled from `updated_at` so no existing listing renders as
 * never-confirmed on day one. That is a deliberate approximation, not a claim
 * of truth: `updated_at` is the best evidence we have of when anyone last
 * touched a row, and starting every live listing at "never confirmed" would
 * paint the whole directory as stale on the day the feature ships, which is
 * both wrong and useless as a signal. Rows go on to earn a real stamp the
 * first time their owner confirms or edits.
 *
 * The column stays nullable rather than defaulting: after the backfill the
 * only `NULL`s are listings created afterwards whose owner has never confirmed
 * and never edited, which is a real and distinct state worth being able to
 * see.
 *
 * Fully transactional: one `ADD COLUMN` (nullable, no rewrite) plus one
 * single-table `UPDATE` over `listings`, which is a small table. No index (the
 * column is read per-listing on the detail payload and never filtered on) and
 * no `CONCURRENTLY`, so nothing here needs to escape the migration
 * transaction.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingDetailsConfirmedAt1793980000000 implements MigrationInterface {
  name = 'AddListingDetailsConfirmedAt1793980000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "details_confirmed_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Seed every existing row from the only timestamp that exists today. Runs
    // in the same transaction as the ADD COLUMN, so a listing is never visible
    // to the application with the column present but unseeded.
    await queryRunner.query(
      `UPDATE "listings" SET "details_confirmed_at" = "updated_at"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "details_confirmed_at"`,
    );
  }
}
