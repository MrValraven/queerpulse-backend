// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pulse Live (code id `quizshow`) wheel rounds: `quizshow_round_kind` gains
 * the label `wheel`, so a quiz can hold a spinning wheel row between its
 * rounds. No column changes: the wheel settings live in the `settings` jsonb
 * and the wheel state in the `cursor` jsonb. The entity's enum follows
 * `QUIZSHOW_ROUND_KINDS`. The template seed migration
 * `1837900000000-AddQuizshowTemplates.ts` stays frozen. Covered by
 * `src/database/quizshow-migrations.postgres.spec.ts`.
 *
 * NON-TRANSACTIONAL, like every other `ADD VALUE` migration here: a new label
 * must be COMMITTED before any statement may use it, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). No statement
 * here uses the new label.
 */
export class AddQuizshowWheel1840000000000 implements MigrationInterface {
  name = 'AddQuizshowWheel1840000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "quizshow_round_kind" ADD VALUE 'wheel'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value. Fails loudly so the
    // ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
