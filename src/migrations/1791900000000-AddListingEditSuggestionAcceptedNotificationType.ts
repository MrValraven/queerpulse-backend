import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_edit_suggestion_accepted` to `notifications_type_enum`, sent
 * to a listing's owner when a moderator accepts a non-owner member's
 * suggested correction (`ListingEditSuggestionsService.resolve`). Mirrors
 * `AddListingClaimNotificationTypes1790800200000` exactly: ADD VALUE only,
 * never used in the same transaction, so this is safe inside the migration
 * transaction on PostgreSQL 12+. `down()` is a documented no-op; Postgres
 * cannot drop an enum value.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddListingEditSuggestionAcceptedNotificationType1791900000000 implements MigrationInterface {
  name = 'AddListingEditSuggestionAcceptedNotificationType1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_edit_suggestion_accepted'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added value is
    // harmless if left in place.
  }
}
