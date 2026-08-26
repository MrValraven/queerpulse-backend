import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LOC-16: venue consent for a gathering attached to a directory listing.
 *
 * Before this, any member could point `events.listing_id` at any live,
 * operating, non-hidden business and that business's public directory page
 * immediately advertised the gathering. The owner was never asked, never told,
 * and had no way to remove it.
 *
 * Five columns on `events` rather than an `event_venue_attachments` join
 * table. The attachment is already ONE nullable FK on this row and an event
 * has at most one venue, so a join table would be 1:1; the CDN-cached venue
 * page read already loads these rows and would otherwise take a join; and
 * every transition writes `listing_id` and its state together, which is one
 * UPDATE here and a two-table invariant there. See `EventVenueConfirmation`
 * in `event.entity.ts` for the full argument.
 *
 * Column defaults matter here: `venue_confirmation` lands NOT NULL DEFAULT
 * 'pending', which is the safe state for anything created from now on. Rows
 * that already existed are moved to `confirmed` by the SEPARATE backfill
 * migration `1794791000000`, so this one stays a pure schema change and the
 * data decision is reviewable on its own.
 */
export class AddEventVenueConfirmation1794790000000 implements MigrationInterface {
  name = 'AddEventVenueConfirmation1794790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "events_venue_confirmation_enum" AS ENUM ('pending', 'confirmed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "events"
         ADD COLUMN "venue_confirmation" "events_venue_confirmation_enum"
           NOT NULL DEFAULT 'pending',
         ADD COLUMN "venue_confirmed_at" TIMESTAMP WITH TIME ZONE,
         ADD COLUMN "venue_owner_notified_at" TIMESTAMP WITH TIME ZONE,
         ADD COLUMN "venue_detached_listing_id" uuid,
         ADD COLUMN "venue_detached_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Serves both readers of an attachment: the venue page (listing +
    // confirmation) and the owner's pending inbox. Partial, because a
    // gathering with no listed venue belongs in no index of listed venues.
    await queryRunner.query(
      `CREATE INDEX "IDX_events_listing_venue_confirmation"
         ON "events" ("listing_id", "venue_confirmation")
         WHERE "listing_id" IS NOT NULL`,
    );
    // The bell + push that ASKS the owner. Additive and idempotent; on PG 12+
    // ADD VALUE runs inside the migration transaction because the new label is
    // not USED in this same transaction. It rides in this migration rather
    // than a third one because the notification and the state it announces are
    // the same change: shipping the columns without the label would give
    // owners a pending queue nothing ever tells them about.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'venue_event_attachment'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_events_listing_venue_confirmation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "events"
         DROP COLUMN "venue_detached_at",
         DROP COLUMN "venue_detached_listing_id",
         DROP COLUMN "venue_owner_notified_at",
         DROP COLUMN "venue_confirmed_at",
         DROP COLUMN "venue_confirmation"`,
    );
    await queryRunner.query(`DROP TYPE "events_venue_confirmation_enum"`);
    // The `venue_event_attachment` label on `notifications_type_enum` stays.
    // Postgres has no `ALTER TYPE ... DROP VALUE`, and an unused label is
    // inert: nothing reads it once the columns above are gone, `up()` re-adds
    // it with `IF NOT EXISTS`, and the ledger row is removed honestly because
    // everything this migration actually created HAS been dropped.
  }
}
