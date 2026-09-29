// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `forum_thread` to `activities_subject_kind_enum`, so a profile's
 * "started a thread" row can name its thread and `ActivityVisibilityService`
 * can re-check it on every read (withdrawn, scheduled, under review, anonymous,
 * official, or in a community that turned private).
 *
 * Runs outside the wrapping transaction (`data-source.ts` sets
 * `migrationsTransactionMode: 'each'`): a new label must be committed before
 * any statement may use it, which is why the backfill that writes this value
 * is its own later migration, `1823800200000-BackfillForumThreadActivitySubjects`.
 */
export class AddForumThreadActivitySubjectKind1823800100000 implements MigrationInterface {
  name = 'AddForumThreadActivitySubjectKind1823800100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "activities_subject_kind_enum" ADD VALUE 'forum_thread'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
