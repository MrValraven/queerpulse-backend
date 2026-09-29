// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-462: adds the `notifications_type_enum` value that lets the magazine
 * desk tell a WRITER when an editor passes on a pitch they submitted from
 * the writer workspace: `magazine_pitch_passed`.
 *
 * Until now a passed pitch sat on the tracker with no signal to the writer at
 * all; they learned the verdict only by opening their own tracker on a
 * hunch.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddMagazinePieceWriterNotificationTypes1806200000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * The app boots with or without it: an enum column only rejects an unknown
 * label at INSERT time, and every emit site swallows its own failure, so
 * until this runs the pitch-pass path simply stays as silent as it was
 * before.
 */
export class AddMagazinePitchPassedNotificationType1826000100000 implements MigrationInterface {
  name = 'AddMagazinePitchPassedNotificationType1826000100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'magazine_pitch_passed'`,
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
