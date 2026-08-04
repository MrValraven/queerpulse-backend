// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the admin moderation queue's new search (item #9,
 * `ListingsService.listQueue`'s `q` param): `l.name ILIKE :pattern`. The
 * table already carries a trigram GIN index on `lower(name)`
 * (`IDX_listings_name_lower_trgm`,
 * `1785700100000-AddSearchTrgmAndTagsIndexes`), but that index only
 * accelerates the `LOWER(listing.name) LIKE ...` shape `DirectoryService`'s
 * public search uses — a different expression from a plain
 * `name ILIKE ...` predicate, so Postgres cannot reuse it here. This
 * migration adds a second trigram GIN index directly on the raw `name`
 * column, which `gin_trgm_ops` supports for `ILIKE` queries natively (no
 * `lower()` wrapper needed on either side).
 *
 * `pg_trgm` is already enabled by the earlier migration —
 * `CREATE EXTENSION IF NOT EXISTS` here is just the idempotent no-op guard,
 * matching that migration's own precedent for the one enable-extension
 * exception to the "no `IF [NOT] EXISTS` guards" rule (CLAUDE.md).
 *
 * The `listings` table already carries production traffic and has prior
 * `CONCURRENTLY` migrations against it, so this index is built
 * `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction block,
 * so the migration opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddListingNameSearchIndex1785902200000 implements MigrationInterface {
  name = 'AddListingNameSearchIndex1785902200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_name_trgm" ` +
        `ON "listings" USING gin ("name" gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_listings_name_trgm"`);
  }
}
