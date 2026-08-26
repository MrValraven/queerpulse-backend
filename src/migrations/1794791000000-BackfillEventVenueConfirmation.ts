import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LOC-16: what happens to the attachments that already exist.
 *
 * Every event/listing link in the table predates venue consent, so nobody ever
 * confirmed any of them. Two options, and only one of them is defensible:
 *
 *  1. Leave them `pending`. The new rule is that a pending attachment is
 *     withheld from the ANONYMOUS, CDN-cached venue page, so this would blank
 *     the "what's on here" block of every business page on the open web the
 *     moment the migration ran, for a feature no owner has had a single
 *     opportunity to act on. Real gatherings that real venues do host would
 *     vanish from public view until an owner who may never sign in pressed a
 *     button they have never seen.
 *  2. Grandfather them to `confirmed` and leave `venue_confirmed_at` NULL.
 *     Nothing disappears without a person deciding, and from the day this
 *     ships every one of them is DETACHABLE by its owner, which is the remedy
 *     the gap actually asked for. The null timestamp keeps the data honest:
 *     the row says "carried since before consent existed", never "an owner
 *     agreed to this at 14:32".
 *
 * This migration is option 2. The new state gates a NEW attachment's FIRST
 * appearance; it is not a retro-active audit of links already published.
 *
 * Kept separate from the schema migration (`1794790000000`) so the schema
 * change and the data decision can be reviewed and reverted independently.
 */
export class BackfillEventVenueConfirmation1794791000000 implements MigrationInterface {
  name = 'BackfillEventVenueConfirmation1794791000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "events"
          SET "venue_confirmation" = 'confirmed'
        WHERE "listing_id" IS NOT NULL
          AND "venue_confirmation" = 'pending'`,
    );
  }

  /**
   * Reverts ONLY what `up()` did. A row an owner has confirmed since carries a
   * `venue_confirmed_at` stamp, and a real human decision is not this
   * migration's to undo, so the predicate is exactly the grandfathered set.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "events"
          SET "venue_confirmation" = 'pending'
        WHERE "listing_id" IS NOT NULL
          AND "venue_confirmation" = 'confirmed'
          AND "venue_confirmed_at" IS NULL`,
    );
  }
}
