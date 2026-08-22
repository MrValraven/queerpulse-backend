import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_claim_approved` and `listing_claim_declined` to
 * `notifications_type_enum`, sent to a claimant once a moderator reviews
 * their claim on an existing business listing
 * (`ListingClaimsService.review`). Mirrors
 * `AddWriterApplicationNotificationTypes1790700000000` exactly: ADD VALUE
 * only, never used in the same transaction, so this is safe inside the
 * migration transaction on PostgreSQL 12+. `down()` is a documented no-op;
 * Postgres cannot drop an enum value.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddListingClaimNotificationTypes1790800200000 implements MigrationInterface {
  name = 'AddListingClaimNotificationTypes1790800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_claim_approved'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_claim_declined'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added values are
    // harmless if left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
