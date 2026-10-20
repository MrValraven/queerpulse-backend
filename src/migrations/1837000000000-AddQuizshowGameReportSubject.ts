// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pulse Live (code id `quizshow`) games without an event: `quizshow_game`
 * joins `reports_subject_type_enum`, so a member can report a game that has
 * no event (the subject id is the session id). A forward migration because
 * `AddQuizshowReportSubject1836000000000` already ran in production with only
 * `quizshow_answer`. Covered by `src/database/quizshow-migrations.postgres.spec.ts`.
 *
 * NON-TRANSACTIONAL, like every other `ADD VALUE` migration here: a new label
 * must be COMMITTED before any statement may use it, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). No statement
 * here uses the new label. Retention: reports about a game follow the
 * existing report rules.
 */
export class AddQuizshowGameReportSubject1837000000000 implements MigrationInterface {
  name = 'AddQuizshowGameReportSubject1837000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'quizshow_game'`,
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
