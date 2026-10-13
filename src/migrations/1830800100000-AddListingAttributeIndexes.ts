// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GIN indexes behind the directory's `attr=` and `practice=` filters, which
 * test array containment (`attributes @> ...`, `inclusion_practices @> ...`)
 * on the hottest public read in the module.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and
 * `listings` carries production traffic, so a blocking build is not
 * acceptable; this migration runs on its own with `transaction = false`
 * (honoured because `src/data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). The columns come from
 * `AddListingAttributes1830800000000`, which runs first.
 *
 * No matching `@Index` decorator exists on the entity: TypeORM's decorator
 * cannot express an index method, so every GIN index in this schema lives in
 * its migration alone (same arrangement as
 * `IDX_listings_accessibility_answers`).
 */
export class AddListingAttributeIndexes1830800100000 implements MigrationInterface {
  name = 'AddListingAttributeIndexes1830800100000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`.
  // Re-runnability comes from the deploy preflight dropping invalid indexes;
  // `IF NOT EXISTS` is forbidden here because it hides schema drift.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_attributes" ON "listings" USING gin ("attributes")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_inclusion_practices" ON "listings" USING gin ("inclusion_practices")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_inclusion_practices"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_attributes"`,
    );
  }
}
