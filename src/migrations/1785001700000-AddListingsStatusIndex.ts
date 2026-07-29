import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3 fix: `Listing.status` (`listings/entities/listing.entity.ts`) had no
 * index despite being filtered on nearly every directory read
 * (`DirectoryService`'s `status = live` gates — `listDirectory`,
 * `listPartnerSpaces`, `listSafeSpaces`, and `loadLiveOr404`, which backs
 * both `getDirectoryBySlug` and `getSafeSpaceBySlug`) and the admin
 * moderation queue (`ListingsService.listQueue`). Mirrors the sibling
 * `housing_listings.status` index added in
 * `1785000020000-AddHousingListings.ts` for the exact same access pattern —
 * that one was created as plain `CREATE INDEX` because it shipped with a
 * brand-new table; `listings` already carries production traffic, so this
 * one uses `CONCURRENTLY` instead.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual), and this project's migration runner
 * wraps pending migrations in one shared transaction by default
 * (`migrationsTransactionMode: 'all'`). Run this migration on its own:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * The matching `@Index('IDX_listings_status')` decorator is on
 * `Listing.status` itself (`listings/entities/listing.entity.ts`) so entity
 * metadata and schema stay in sync for any future `migration:generate` diff.
 */
export class AddListingsStatusIndex1785001700000
  implements MigrationInterface
{
  name = 'AddListingsStatusIndex1785001700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_status" ON "listings" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_listings_status"`);
  }
}
