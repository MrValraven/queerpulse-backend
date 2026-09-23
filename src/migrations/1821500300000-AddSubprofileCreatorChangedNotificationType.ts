// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `subprofile_creator_changed` to `notifications_type_enum`: the in-app
 * notice every remaining co-owner of a persona receives when the creator role
 * passes to the longest-standing of them.
 *
 * Runs outside the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`), like the
 * other `ADD VALUE` migrations here: a new label must be committed before any
 * statement may use it. The file is one statement, so it still applies
 * all or nothing. Nothing in this file uses the new label.
 */
export class AddSubprofileCreatorChangedNotificationType1821500300000 implements MigrationInterface {
  name = 'AddSubprofileCreatorChangedNotificationType1821500300000';
  // ALTER TYPE ... ADD VALUE commits its label on its own.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE 'subprofile_creator_changed'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
