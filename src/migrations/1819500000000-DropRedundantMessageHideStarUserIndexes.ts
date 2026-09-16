// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops two redundant standalone `user_id` indexes (messaging deep scan
 * 2026-09-15, ENG-257):`IDX_message_hides_user_id` on `message_hides` and
 * `IDX_message_stars_user_id` on `message_stars`. Both tables already carry
 * a table-level composite unique constraint leading with `user_id`
 * (`UQ_message_hides` and `UQ_message_stars`, both `(user_id, message_id)`,
 * see `message-hide.entity.ts` and `message-star.entity.ts`'s `@Unique(...)`),
 * per Postgres's leading-column rule ("Multicolumn Indexes", PostgreSQL
 * manual), that composite unique index already serves any query filtering
 * on `user_id` alone. Every read against these tables (`messages.service.ts`,
 * `message-annotations.service.ts`, `messaging-core.service.ts`) filters on
 * `user_id` together with `message_id` anyway, a shape the unique index
 * already serves fully. The standalone single-column indexes therefore
 * duplicate the unique index's leading column, buying write amplification
 * on every hide and star (`message_hides`/`message_stars` are written on
 * every "delete for me" and star/unstar) with no query they uniquely serve.
 * `IDX_message_hides_message_id` and `IDX_message_stars_message_id` are NOT
 * touched. `message_id` isn't the leading column of either unique
 * constraint, so those two remain the load-bearing single-column indexes on
 * these tables.
 *
 * Both tables carry production traffic, so the drops use `DROP INDEX
 * CONCURRENTLY` to avoid taking a write lock. CONCURRENTLY cannot run inside
 * a transaction block, so `transaction = false` opts this migration out; the
 * data source's `migrationsTransactionMode: 'each'` honours that in a plain
 * `migration:run`.
 *
 * `down()` recreates both indexes the same way they were originally built
 * (`CONCURRENTLY`), so a revert never takes a write lock on either table.
 */
export class DropRedundantMessageHideStarUserIndexes1819500000000 implements MigrationInterface {
  name = 'DropRedundantMessageHideStarUserIndexes1819500000000';

  // Runs outside a transaction for `CONCURRENTLY`.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_message_hides_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_message_stars_user_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_message_hides_user_id" ` +
        `ON "message_hides" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_message_stars_user_id" ` +
        `ON "message_stars" ("user_id")`,
    );
  }
}
