// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes behind the directory's credit lookups. `subprofile_items.collaborators`
 * holds the normalized handle names an item credits, and the credit counts,
 * faces and "Made together" wall all test that array for containment or scan
 * the newest credited items.
 *
 * - `IDX_subprofile_items_collaborators` is a GIN index for array containment
 *   (`collaborators && ...` / `collaborators @> ...`) on handle lookups.
 * - `IDX_subprofile_items_credited_recent` is a partial btree on `created_at`
 *   restricted to items that carry at least one credit, so the newest-first
 *   "Made together" candidate window reads only credited rows.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and
 * `subprofile_items` carries production traffic, so a blocking build is not
 * acceptable; this migration runs on its own with `transaction = false`
 * (honoured because `src/data-source.ts` sets
 * `migrationsTransactionMode: 'each'`).
 *
 * No matching `@Index` decorator exists on the entity: TypeORM's decorator
 * cannot express an index method or a partial predicate, so these indexes
 * live in this migration alone (same arrangement as
 * `IDX_listings_accessibility_answers`).
 */
export class AddSubprofileItemCreditIndexes1838900000000 implements MigrationInterface {
  name = 'AddSubprofileItemCreditIndexes1838900000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`.
  // Re-runnability comes from the deploy preflight dropping invalid indexes;
  // `IF NOT EXISTS` is forbidden here because it hides schema drift.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofile_items_collaborators" ON "subprofile_items" USING gin ("collaborators")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofile_items_credited_recent" ON "subprofile_items" ("created_at" DESC) WHERE "collaborators" <> '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_subprofile_items_credited_recent"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_subprofile_items_collaborators"`,
    );
  }
}
