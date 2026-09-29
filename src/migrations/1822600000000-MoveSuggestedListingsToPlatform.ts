// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Suggested listings are held by the platform.
 *
 * 1. Adds `listings.suggested_by_user_id` (uuid, nullable, FK to `users`
 *    ON DELETE SET NULL, indexed). The member who suggested a place is kept
 *    apart from ownership: it grants them nothing on the listing.
 * 2. Adds `staff_edited` to `listing_moderation_events_action_enum`, written
 *    by `ListingsService.adminUpdate`. ADD VALUE only, and nothing in this
 *    file writes the label, so it is safe inside the migration transaction.
 * 3. Moves every existing suggestion that nobody has claimed to the
 *    platform: `owner_id` moves to `suggested_by_user_id`, the owner-personal
 *    columns (including `visibility`) are blanked, and every live co-manager
 *    seat on the listing is revoked (staff-attached seats stay), mirroring
 *    `ListingOwnershipService.transferOwnership`. This migration is itself
 *    the only record of the move: unlike a real transfer it writes no
 *    `listing_moderation_events` row, because there is no moderator actor to
 *    attribute the row to.
 *
 * A suggestion is left alone, owner untouched, when real ownership already
 * reached it: an approved `listing_claims` row, or a `listing_moderation_events`
 * row with `action = 'ownership_transferred'` (written by every transfer
 * path: `ListingOwnershipService.transferOwnership`, reached from both an
 * approved claim in `ListingClaimsService.review` and an accepted staff offer
 * in `ListingOwnerOffersService.respond`). The approved-claim check is kept
 * alongside the audit-row check because it predates `ownership_transferred`
 * (`AddListingOwnershipTransferredAction1793530200000`), so it still catches
 * a transfer old enough to have left no audit row of its own.
 *
 * Also skipped by design: a suggestion whose listing identity already has a
 * business mailbox conversation. SQL cannot resync that mailbox the way the
 * service does, so such a row keeps its owner for a manual transfer. The
 * skipped count is logged with `console.warn`: TypeORM only forwards a
 * Postgres notice when `logNotifications` is set on the connection, which
 * nothing in this codebase sets, so a `RAISE NOTICE` here would go entirely
 * unseen. Enquiries on suggestions have always answered `unclaimed`, so the
 * count is expected to be zero.
 *
 * `down()` drops the column and then throws: the enum value cannot be
 * dropped, and the moved suggestions cannot be handed back to their
 * suggesters once the column that remembers them is gone. The throw rolls the
 * drop back, so a revert changes nothing.
 */
export class MoveSuggestedListingsToPlatform1822600000000 implements MigrationInterface {
  name = 'MoveSuggestedListingsToPlatform1822600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD COLUMN "suggested_by_user_id" uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_suggested_by_user_id" ON "listings" ("suggested_by_user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD CONSTRAINT "FK_listings_suggested_by_user_id" FOREIGN KEY ("suggested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TYPE "listing_moderation_events_action_enum" ADD VALUE IF NOT EXISTS 'staff_edited'`,
    );

    // Shared guard: true when `l.owner_id` did NOT come from a real transfer
    // (no `ownership_transferred` audit row and no approved claim), so the
    // suggester still holds the row and it may be moved. See the class
    // comment for why both the audit-row check and the approved-claim check
    // are kept.
    const hasNoRealTransfer = `
      NOT EXISTS (
        SELECT 1 FROM listing_moderation_events e
        WHERE e.listing_id = l.id AND e.action = 'ownership_transferred'
      )
      AND NOT EXISTS (
        SELECT 1 FROM listing_claims lc
        WHERE lc.listing_id = l.id AND lc.status = 'approved'
      )
    `;

    // True when the listing's identity has ever been seated in a
    // conversation. See the class comment for why that row is left alone
    // instead of being moved here.
    const hasMailboxConversation = `
      EXISTS (
        SELECT 1 FROM identities i
        JOIN conversation_participants cp ON cp.identity_id = i.id
        WHERE i.kind = 'listing' AND i.listing_id = l.id
      )
    `;

    // Every suggestion nobody has claimed, that carries no real-ownership
    // record, and whose identity has no mailbox conversation yet. Shared by
    // both backfill statements below, so the two can never drift apart.
    const movableWhere = `
      l.path = 'suggest'
      AND l.owner_id IS NOT NULL
      AND ${hasNoRealTransfer}
      AND NOT (${hasMailboxConversation})
    `;

    // a) Revoke every live co-manager seat on a movable listing, exactly the
    //    scope `ListingCoManagersService.revokeAllForOwnershipTransfer` uses
    //    for a real transfer: `status IN ('invited', 'active')` and
    //    `is_staff_attached = false`, whoever invited the seat. A seat staff
    //    attached (`is_staff_attached = true`) was put there for whoever ends
    //    up owning the listing and stays.
    await queryRunner.query(`
      WITH movable AS (
        SELECT l.id, l.owner_id FROM listings l WHERE ${movableWhere}
      )
      UPDATE listing_co_managers lcm
      SET status = 'revoked', ended_at = now()
      FROM movable m
      WHERE lcm.listing_id = m.id
        AND lcm.is_staff_attached = false
        AND lcm.status IN ('invited', 'active')
    `);

    // b) Move the suggester off `owner_id` and blank the owner-personal
    //    fields, the same columns `ListingOwnershipService.transferOwnership`
    //    clears when a listing changes hands (including the retired
    //    `contact_email`, scrubbed there for the same reason) plus
    //    `visibility`, which the spec's blank list also names.
    await queryRunner.query(`
      WITH movable AS (
        SELECT l.id, l.owner_id FROM listings l WHERE ${movableWhere}
      )
      UPDATE listings l
      SET suggested_by_user_id = m.owner_id,
          owner_id = NULL,
          owner_name = '',
          owner_role = '',
          owner_bio = '',
          rel = '',
          visibility = '',
          consent_outing = false,
          consent_guide = false,
          link_to_profile = false,
          contact_email = ''
      FROM movable m
      WHERE l.id = m.id
    `);

    // c) Count the rows the mailbox guard held back, and log it loudly
    //    through TypeScript. See the class comment for why `RAISE NOTICE`
    //    would not actually be seen. This is expected to log nothing.
    const skippedRows: { skipped_count: string }[] = await queryRunner.query(`
      SELECT count(*) AS skipped_count
      FROM listings l
      WHERE l.path = 'suggest'
        AND l.owner_id IS NOT NULL
        AND ${hasNoRealTransfer}
        AND ${hasMailboxConversation}
    `);
    const skippedCount = Number(skippedRows[0]?.skipped_count ?? 0);
    if (skippedCount > 0) {
      console.warn(
        `[MoveSuggestedListingsToPlatform] ${skippedCount} suggestion(s) kept their owner because a mailbox conversation already exists on the listing.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP CONSTRAINT "FK_listings_suggested_by_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listings_suggested_by_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "suggested_by_user_id"`,
    );
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value, and the suggestions this moved cannot be handed back without the column. Restore from a backup instead.',
    );
  }
}
