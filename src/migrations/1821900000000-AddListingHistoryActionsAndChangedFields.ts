// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the owner-facing listing history (`GET /listings/:ref/history`).
 *
 * Adds three values to `listing_moderation_events_action_enum`:
 * - `suggestion_applied`, written by `ListingEditSuggestionsService.resolve`
 *   when a moderator accepts an edit suggestion and the suggested value is
 *   actually written to the listing;
 * - `directory_paused` and `directory_resumed`, written by
 *   `ListingsService.setDirectoryVisibility` when an owner or co-manager hides
 *   the listing from the directory or brings it back.
 *
 * Adds the nullable `changed_fields` text array to `listing_moderation_events`.
 * It holds the `Listing` property names an `owner_edited` or
 * `suggestion_applied` row touched, so the frontend can name the changed
 * fields in the reader's language. Every other action and every existing row
 * leaves it null.
 *
 * Mirrors `AddListingOwnershipTransferredAction1793530200000`: ADD VALUE only,
 * and nothing in this file uses the new labels, so it runs safely inside the
 * migration transaction on PostgreSQL 12+ and the enum values and the column
 * land together. `down()` drops the column and then fails loudly, because
 * Postgres cannot drop an enum value. The throw rolls the column drop back
 * inside the migration transaction, so a revert leaves the schema untouched
 * and the ledger row in place.
 */
export class AddListingHistoryActionsAndChangedFields1821900000000 implements MigrationInterface {
  name = 'AddListingHistoryActionsAndChangedFields1821900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'suggestion_applied'`,
    );
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'directory_paused'`,
    );
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'directory_resumed'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_moderation_events" ADD COLUMN "changed_fields" text array NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_moderation_events" DROP COLUMN "changed_fields"`,
    );
    // The three enum values stay: Postgres has no `ALTER TYPE ... DROP VALUE`.
    // Fails loudly so a revert that could only undo half of `up()` never
    // reports success. The throw also rolls the column drop above back, so
    // the net effect of a revert is no change at all.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
