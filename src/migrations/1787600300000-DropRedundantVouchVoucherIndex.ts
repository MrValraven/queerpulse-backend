// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the redundant `IDX_vouches_voucher_id` (Performance audit finding
 * B9, `references/database-and-indexing.md` Fix #3). `vouches` already
 * carries a table-level composite unique constraint
 * `UQ_vouches_voucher_vouchee` on `(voucher_id, vouchee_id)`
 * (`vouch.entity.ts`'s `@Unique(...)`) — per Postgres's leading-column rule
 * ("Multicolumn Indexes", PostgreSQL manual), that composite unique index
 * already serves any query filtering on `voucher_id` alone, the same way a
 * phone book sorted `(surname, firstname)` still serves a surname-only
 * lookup. The standalone single-column `IDX_vouches_voucher_id` therefore
 * duplicates it — pure write amplification (`vouches` is written on every
 * vouch create/reactivate/withdraw) with no query it uniquely serves.
 * `IDX_vouches_vouchee_id` is NOT touched — `vouchee_id` isn't the leading
 * column of anything else, so it's the one load-bearing single-column index
 * on this table.
 *
 * `vouches` carries production traffic, so the drop runs `DROP INDEX
 * CONCURRENTLY` (matches the build side's `CREATE INDEX CONCURRENTLY`
 * convention) rather than a plain blocking `DROP INDEX`. Cannot run inside a
 * transaction block — `transaction = false` opts this migration out. Run
 * alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * `down()` recreates the index the same way it was originally built
 * (`CONCURRENTLY`), so a revert never takes a write lock on `vouches`
 * either.
 */
export class DropRedundantVouchVoucherIndex1787600300000
  implements MigrationInterface
{
  name = 'DropRedundantVouchVoucherIndex1787600300000';

  // Runs outside a transaction for `CONCURRENTLY`.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_vouches_voucher_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_vouches_voucher_id" ` +
        `ON "vouches" ("voucher_id")`,
    );
  }
}
