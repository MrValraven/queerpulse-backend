import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-HSG-05: adds `ownership_transferred` to
 * `listing_moderation_events_action_enum`, written by
 * `ListingClaimsService.review` when an approved claim moves a listing's
 * `ownerId` from one member to another.
 *
 * Before this, an ownership transfer was the one moderator action on a listing
 * that left no trace: the previous owner silently lost every `:ref` route on
 * their listing and nothing landed in the audit trail
 * (`GET /listings/admin/:ref/history`) to review afterwards.
 *
 * Mirrors `AddListingClaimNotificationTypes1790800200000` exactly: ADD VALUE
 * only, never used in the same transaction, so this is safe inside the
 * migration transaction on PostgreSQL 12+. `down()` is a documented no-op;
 * Postgres cannot drop an enum value.
 */
export class AddListingOwnershipTransferredAction1793530200000 implements MigrationInterface {
  name = 'AddListingOwnershipTransferredAction1793530200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'ownership_transferred'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added value is harmless
    // if left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
