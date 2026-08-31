import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The enum labels behind the housing publish gate (LOC-01).
 *
 * `housing_listings_status_enum` gains two terminal moderation states. Until
 * now a moderator could only move a listing between `review`, `question` and
 * `live`, so there was no way to say "we are not publishing this" or "we have
 * pulled this" at all, and no way for the lister to be told which of the two
 * happened:
 *  - `rejected`: refused, with a required reason. Never publicly browsable.
 *    Not a grave: an owner edit that changes moderated content returns the
 *    listing to `review` (`HousingListingsService.update`), so a lister who
 *    fixes the problem gets re-reviewed instead of posting a duplicate.
 *  - `taken_down`: was live, then pulled by a moderator, with a required
 *    reason. Kept distinct from `rejected` because they are different facts to
 *    the member and to any transparency report: only one of them was ever
 *    visible to the community.
 *
 * `notifications_type_enum` gains `housing_listing_decision`, the in-app plus
 * push row every one of those decisions now writes to the lister
 * (`HousingListingModerationService.decide`). QueerPulse sends no email.
 *
 * Nothing needs backfilling: every existing row keeps the status it has, and
 * public browse serves `live` only, so neither new label changes what any
 * current query returns.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE` migrations
 * (e.g. `AddReportFiledNotificationTypes1794600000000`): `ALTER TYPE ... ADD
 * VALUE` must be COMMITTED before any statement may use the new label, so this
 * opts out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). The companion
 * `AddHousingListingDecisionAudit1794721000000` adds the columns and runs
 * after, and deliberately references none of these labels.
 */
export class AddHousingModerationDecisionEnums1794720000000 implements MigrationInterface {
  name = 'AddHousingModerationDecisionEnums1794720000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "housing_listings_status_enum" ADD VALUE IF NOT EXISTS 'rejected'`,
    );
    await queryRunner.query(
      `ALTER TYPE "housing_listings_status_enum" ADD VALUE IF NOT EXISTS 'taken_down'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_listing_decision'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added labels are
    // harmless. Fails loudly rather than reporting a successful revert that
    // undid nothing, since a silent no-op removes the ledger row and the next
    // `migration:run` retries `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
