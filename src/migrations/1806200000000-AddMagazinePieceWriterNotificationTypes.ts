// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-121 — adds the three `notifications_type_enum` values that finally let
 * the magazine desk tell a WRITER what is happening to their piece:
 * `magazine_piece_commissioned`, `magazine_piece_stage_changed` and
 * `magazine_piece_published`.
 *
 * Until now the only writer-facing piece notification was
 * `magazine_piece_message`. Commissioning, assigning, every stage change and
 * publishing all wrote nothing at all, so a writer discovered they had been
 * given a piece, or that it had gone live, only by opening
 * `/magazine/writer` and looking.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddConcernUpdateNotificationType1788600000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * The app boots with or without it: an enum column only rejects an unknown
 * label at INSERT time, and every emit site swallows its own failure, so
 * until this runs the desk simply stays as silent as it was before.
 */
export class AddMagazinePieceWriterNotificationTypes1806200000000 implements MigrationInterface {
  name = 'AddMagazinePieceWriterNotificationTypes1806200000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'magazine_piece_commissioned'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'magazine_piece_stage_changed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'magazine_piece_published'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres has no `ALTER TYPE ... DROP VALUE`, and the
    // added labels are harmless if left. Fails loudly rather than reporting a
    // successful revert that undid nothing: a silent no-op removes the row
    // from the migrations ledger, so the next `migration:run` retries
    // `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
