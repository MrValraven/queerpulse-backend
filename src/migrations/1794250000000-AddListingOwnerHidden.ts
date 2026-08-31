import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.is_hidden_by_owner` + `listings.owner_hidden_at`: the owner pause.
 *
 * An owner could edit their listing or delete it, with nothing in between, so
 * listings were being deleted for reasons that were temporary: a summer away,
 * a rebrand mid-flight, a month too short-staffed to take the enquiries. A
 * delete takes the reviews, the photos and the moderation history with it, and
 * none of that comes back when the reason passes. This is the reversible
 * middle: withdraw the listing from the directory, keep everything.
 *
 * DISTINCT from `operating_state` (`1793970000000-AddListingOperatingState`),
 * and the two must never be folded into each other:
 *
 *   - `operating_state` describes THE BUSINESS. Is it trading? That is a fact
 *     about the world, and a reader is entitled to it, which is why a
 *     permanently closed listing keeps its detail page: every shared link,
 *     bookmark and review points there, and a 404 would erase the record
 *     rather than correct it.
 *   - `is_hidden_by_owner` describes THE LISTING. Is the owner currently
 *     showing it? That is a fact about their relationship with this directory,
 *     and it is theirs to decide. A thriving business can pause its listing; a
 *     permanently closed one can leave its listing up.
 *
 * Neither implies the other, and neither is derivable from the other.
 *
 * The pause applies to the same public read paths `permanently_closed` already
 * filters (`DirectoryService.excludeHiddenFromDirectory` and its `find()`-option
 * twin `PUBLICLY_LISTED`), and goes one step further: it also withholds the
 * DETAIL page. Honouring "do not show my listing" halfway, so that it stays
 * readable by direct link and is merely harder to find, would not be honouring
 * it. Nothing is deleted, and unhiding restores the page exactly as it was.
 * The owner reaches their own paused listing through the owner-scoped routes
 * (`GET /listings/mine`, `GET /listings/:ref`) to put it back.
 *
 * `owner_hidden_at` is stamped only on the transition into hidden and cleared
 * on the way out, so "hidden since 4 March" survives a repeated PATCH of the
 * same value and a shown listing never carries a stale date.
 *
 * Fully transactional. The `ALTER TABLE ... ADD COLUMN` already takes an ACCESS
 * EXCLUSIVE lock on `listings` for the duration, so the plain `CREATE INDEX`
 * alongside it adds no lock class the migration was not already taking, and no
 * `CONCURRENTLY` two-phase split is needed. Same shape as
 * `1793970000000-AddListingOperatingState`, which added the sibling
 * `operating_state` column and its index the same way.
 */
export class AddListingOwnerHidden1794250000000 implements MigrationInterface {
  name = 'AddListingOwnerHidden1794250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings"
         ADD "is_hidden_by_owner" boolean NOT NULL DEFAULT false,
         ADD "owner_hidden_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Every public directory read now carries an `is_hidden_by_owner = false`
    // predicate, alongside the `operating_state` one it already had. Same shape
    // as `IDX_listings_operating_state`.
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_is_hidden_by_owner" ON "listings" ("is_hidden_by_owner")`,
    );
    // No backfill: `false` is correct for every existing row. A listing nobody
    // has ever paused is a listing that is shown.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_listings_is_hidden_by_owner"`);
    await queryRunner.query(
      `ALTER TABLE "listings"
         DROP COLUMN "owner_hidden_at",
         DROP COLUMN "is_hidden_by_owner"`,
    );
  }
}
