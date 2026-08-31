import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `owner_edited` to `listing_moderation_events_action_enum`, written by
 * `ListingsService.update` when the owner of a LIVE listing edits it.
 *
 * An owner edit used to flip a live listing back to `review`, which silently
 * removed the business from the public directory (`DirectoryService` reads
 * detail pages with `status = live`) until a moderator cleared it again, so
 * correcting a phone number cost an approved listing its visibility. That flip
 * is gone: once a listing is approved it stays live through its owner's edits.
 * This action is what keeps moderators informed instead, recording who edited a
 * published listing and, in the `reason`, what they changed in plain language,
 * including when the edit cleared the listing's `queerOwnedVerified` badge.
 *
 * Mirrors `AddListingOwnershipTransferredAction1793530200000` exactly: ADD
 * VALUE only, never used in the same transaction, so this is safe inside the
 * migration transaction on PostgreSQL 12+. `down()` is irreversible; Postgres
 * cannot drop an enum value.
 */
export class AddListingOwnerEditedAction1793960000000 implements MigrationInterface {
  name = 'AddListingOwnerEditedAction1793960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'owner_edited'`,
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
