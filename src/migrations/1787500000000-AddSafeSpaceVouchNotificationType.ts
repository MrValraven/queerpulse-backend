// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing safe-space vouch
 * notifications: `safe_space_vouch`, sent to a safe space's listing OWNER when a
 * member vouches for it (`SafeSpaceVouchesService.createVouch`). Before this, a
 * safe-space vouch notified no one — the owner never learned their space was
 * vouched for.
 *
 * TWO-PHASE / NON-TRANSACTIONAL. `ALTER TYPE ... ADD VALUE` is committed on its
 * own here — the migration opts out of the wrapping transaction
 * (`transaction = false`, honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`), for the same family of reasons the
 * `CREATE INDEX CONCURRENTLY` migrations do: an enum value must be COMMITTED
 * before any statement may USE it, so adding and using it in one transaction is
 * unsafe. Keeping the ADD VALUE in its own committed step means the code that
 * writes `SafeSpaceVouch` rows (a separate deploy) always sees a durable enum
 * label. `IF NOT EXISTS` keeps the step re-run-safe. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * `down()` is a documented no-op — Postgres has no `ALTER TYPE ... DROP VALUE`;
 * the added label is harmless if left in place.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddSafeSpaceVouchNotificationType1787500000000 implements MigrationInterface {
  name = 'AddSafeSpaceVouchNotificationType1787500000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'safe_space_vouch'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added value is harmless if
    // left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
