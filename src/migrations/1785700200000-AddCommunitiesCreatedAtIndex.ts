import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the Performance & Cost audit's "admin-communities full-platform
 * scan" finding (AUDIT-2026-07-30.md §I): `AdminCommunitiesService.listCommunities`
 * (`src/admin-communities/admin-communities.service.ts`) runs
 * `this.communities.find({ order: { createdAt: 'ASC' } })` with no `WHERE`
 * and, until the paired code change in this same fix, no `take` — every
 * community on the platform, unbounded, on every admin dashboard load.
 *
 * `communities` carried no index on `created_at` at all, so the `ORDER BY`
 * that query issues could only be served by a `Seq Scan` + `Sort` over the
 * whole table. The paired service change adds a hard `take` cap (matching
 * the precedent at `admin-trust-network.service.ts`'s `MAX_NODES`), but a
 * `LIMIT` only turns into a cheap `Index Scan ... Limit` plan (stopping after
 * the first N rows) when the sort itself is backed by an index — otherwise
 * Postgres still has to materialize and sort the entire table before it can
 * hand back the first page. This index is what makes the cap actually cut
 * cost, not just cut the bytes returned over the wire.
 *
 * `communities` already carries production traffic (see the prior
 * `CONCURRENTLY` migrations against it in `1785700100000-AddSearchTrgmAndTagsIndexes.ts`),
 * so this is built `CREATE INDEX CONCURRENTLY`, never a blocking plain
 * `CREATE INDEX`.
 *
 * The matching `@Index('IDX_communities_created_at')` decorator is on
 * `Community.createdAt` itself (`communities/entities/community.entity.ts`)
 * so entity metadata and schema stay in sync for any future
 * `migration:generate` diff.
 */
export class AddCommunitiesCreatedAtIndex1785700200000 implements MigrationInterface {
  name = 'AddCommunitiesCreatedAtIndex1785700200000';

  // CONCURRENTLY cannot run inside a transaction block ("`CREATE INDEX`",
  // PostgreSQL manual) — `migrationsTransactionMode: 'each'` (data-source.ts)
  // is what lets this migration opt out per-migration via `transaction = false`
  // instead of being force-wrapped into one shared batch transaction.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_communities_created_at" ` +
        `ON "communities" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_communities_created_at"`,
    );
  }
}
