import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operating state on `listings`: whether the BUSINESS is still trading, as
 * reported by the business itself.
 *
 * `listings.status` is the MODERATION lifecycle (`review`/`question`/`live`)
 * and stays exactly what it was. A venue that shut in March is still a
 * perfectly well-moderated `live` listing, and until now it went on presenting
 * itself in full health with hours, a phone number and directions. That is the
 * gap this closes, without overloading `status` (which would have meant a
 * moderator action every time a business took a summer break, and would have
 * destroyed the record of the moderation decision itself).
 *
 * Written only by the listing owner
 * (`PATCH /listings/:ref/operating-state`). `permanently_closed` withdraws the
 * listing from every public list/search/map/safe-space result in
 * `DirectoryService`; the detail page still resolves so existing links,
 * reviews and the closure notice survive.
 *
 * `moved_to_listing_id` is a self-referencing FK to the successor listing, when
 * the moved business already has its own row. `ON DELETE SET NULL`: deleting
 * the successor must never delete its predecessor's history, it just drops the
 * link.
 *
 * Fully transactional. The `ALTER TABLE ... ADD COLUMN` already takes an
 * ACCESS EXCLUSIVE lock on `listings` for the duration, so the two plain
 * `CREATE INDEX` statements alongside it add no lock class the migration was
 * not already taking, and no `CONCURRENTLY` two-phase split is needed. Mirrors
 * `1782800880000-AddListingSafeSpace` exactly, which added the sibling
 * `safe_space_status` enum column and its index the same way.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingOperatingState1793970000000 implements MigrationInterface {
  name = 'AddListingOperatingState1793970000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listings_operating_state_enum" AS ENUM('open', 'temporarily_closed', 'permanently_closed', 'moved')`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings"
         ADD "operating_state" "listings_operating_state_enum" NOT NULL DEFAULT 'open',
         ADD "operating_state_note" text NOT NULL DEFAULT '',
         ADD "operating_state_set_at" TIMESTAMP WITH TIME ZONE,
         ADD "moved_to_address" text NOT NULL DEFAULT '',
         ADD "moved_to_listing_id" uuid,
         ADD CONSTRAINT "FK_listings_moved_to_listing" FOREIGN KEY ("moved_to_listing_id")
           REFERENCES "listings"("id") ON DELETE SET NULL`,
    );
    // Every public directory read now carries an
    // `operating_state <> 'permanently_closed'` predicate, and the owner/ops
    // surfaces filter on the closed values directly. Same shape as
    // `IDX_listings_safe_space_status`.
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_operating_state" ON "listings" ("operating_state")`,
    );
    // Partial, because the overwhelming majority of listings never point at a
    // successor. Without it, deleting any listing has to sequentially scan
    // `listings` to enforce the `ON DELETE SET NULL` above.
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_moved_to_listing_id" ON "listings" ("moved_to_listing_id")
         WHERE "moved_to_listing_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_listings_moved_to_listing_id"`);
    await queryRunner.query(`DROP INDEX "IDX_listings_operating_state"`);
    await queryRunner.query(
      `ALTER TABLE "listings"
         DROP CONSTRAINT "FK_listings_moved_to_listing",
         DROP COLUMN "moved_to_listing_id",
         DROP COLUMN "moved_to_address",
         DROP COLUMN "operating_state_set_at",
         DROP COLUMN "operating_state_note",
         DROP COLUMN "operating_state"`,
    );
    await queryRunner.query(`DROP TYPE "listings_operating_state_enum"`);
  }
}
