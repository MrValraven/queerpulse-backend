// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persona feed import: adds the `notifications_type_enum` value that tells a
 * persona's members new podcast episodes are waiting for review:
 * `persona_import_ready`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddMagazinePitchPassedNotificationType1826000100000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * The app boots with or without it: an enum column only rejects an unknown
 * label at INSERT time, and the scheduled sync swallows a failed notification
 * write, so until this runs the review list simply fills without a bell.
 */
export class AddPersonaImportReadyNotificationType1827800200000 implements MigrationInterface {
  name = 'AddPersonaImportReadyNotificationType1827800200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'persona_import_ready'`,
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
