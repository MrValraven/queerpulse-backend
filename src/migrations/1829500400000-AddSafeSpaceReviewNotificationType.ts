// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DES-417: adds the `notifications_type_enum` value that carries every
 * safe-space review bell (nomination steps, badge suspension and restore,
 * flag outcomes, the staff overdue nudge): `safe_space_review`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddPersonaImportReadyNotificationType1827800200000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Rows written before this ran keep their `moderation_outcome` type and a
 * `safe_space_*` action; the frontend renders those with a neutral line.
 * Until this runs, `SafeSpaceNotifierService` logs and swallows the failed
 * insert, so every review decision still lands, without its bell.
 */
export class AddSafeSpaceReviewNotificationType1829500400000 implements MigrationInterface {
  name = 'AddSafeSpaceReviewNotificationType1829500400000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'safe_space_review'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres has no `ALTER TYPE ... DROP VALUE`, and the
    // added label is harmless if left. Fails loudly, so the caller learns the
    // revert did nothing: a silent success would remove the row from the
    // migrations ledger, and the next `migration:run` would retry
    // `ADD VALUE` against a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
