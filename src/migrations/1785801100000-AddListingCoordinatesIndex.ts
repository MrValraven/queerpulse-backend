import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Item #5 — backs the coordinate branch of the wizard's similar-listing dedupe
 * (`ListingsService.findSimilar`, `GET /listings/similar`). That query prefilters
 * candidates with a lat/lng bounding box
 * (`latitude BETWEEN … AND longitude BETWEEN …`); a composite b-tree on
 * `(latitude, longitude)` lets the planner serve the range prefilter by index
 * instead of a full scan, and combine it (via `BitmapOr`) with the existing
 * `IDX_listings_name_lower_trgm` GIN trigram index that already serves the
 * name branch — so NO new name index is added here (the trigram one from
 * `1785700100000-AddSearchTrgmAndTagsIndexes.ts` is reused as-is).
 *
 * The `listings` table already carries production traffic and has prior
 * `CONCURRENTLY` migrations against it, so this index is built
 * `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction block, so
 * the migration opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddListingCoordinatesIndex1785801100000 implements MigrationInterface {
  name = 'AddListingCoordinatesIndex1785801100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_coordinates" ` +
        `ON "listings" ("latitude", "longitude")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_coordinates"`,
    );
  }
}
