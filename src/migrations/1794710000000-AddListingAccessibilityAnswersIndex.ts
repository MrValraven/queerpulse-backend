import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GIN index behind the public directory's `access=` filter (LOC-12).
 *
 * `listings.accessibility_answers` has held the six canonical accessibility
 * answers since `AddListingAccessibilityAnswers1794210000000`, but nothing
 * could search on them. `ListListingDirectoryQuery.access` now does, and
 * `DirectoryService.buildDirectoryQuery` expresses it as ONE containment test:
 *
 *   "accessibility_answers" @> '{"step-free-entrance":"yes"}'::jsonb
 *
 * Without an index that is a sequential scan of every live listing on the
 * hottest read in the module, and it is on the path of the paginated grid's
 * `COUNT(*)` as well as its page.
 *
 * `jsonb_path_ops` rather than the default `jsonb_ops`: containment (`@>`) is
 * the only operator this column is ever queried with, and `jsonb_path_ops`
 * indexes whole key/value paths rather than every key and every value
 * separately. The index is materially smaller and the containment lookup
 * faster. The cost is that it cannot serve key-existence operators (`?`,
 * `?|`, `?&`), which nothing here uses. Revisit only if a query needs one.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("CREATE INDEX", PostgreSQL manual), and this project's migration runner
 * wraps pending migrations in one shared transaction by default
 * (`migrationsTransactionMode: 'all'`). `listings` already carries production
 * traffic, so a blocking build is not acceptable here. Run this migration on
 * its own:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * No matching `@Index` decorator exists on the entity: TypeORM's decorator
 * cannot express an index method, so every GIN index in this schema lives in
 * its migration alone, with a pointer comment on the column it serves (same
 * arrangement as `IDX_communities_tags`).
 */
export class AddListingAccessibilityAnswersIndex1794710000000 implements MigrationInterface {
  name = 'AddListingAccessibilityAnswersIndex1794710000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`. Re-runnability
  // comes from the deploy preflight dropping invalid indexes, not from
  // `IF NOT EXISTS` (forbidden here — it hides schema drift). See
  // `1785001700000-AddListingsStatusIndex`.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_accessibility_answers"
         ON "listings" USING gin ("accessibility_answers" jsonb_path_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_accessibility_answers"`,
    );
  }
}
