import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the issue-production columns to `magazine_issue` (Magazine Desk
 * Phase 5, Task 1) that back the new run-order/digest/cover system
 * introduced on the entity in the same task
 * (`magazine-issue.entity.ts`): `theme`, `run_order`, `digest`, and
 * `coverlines`.
 *
 * All columns are `NOT NULL` with defaults so the migration is safe against
 * existing rows — no backfill step needed.
 */
export class AddIssueProduction1786700000000 implements MigrationInterface {
  name = 'AddIssueProduction1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_issue"
        ADD COLUMN "theme" character varying NOT NULL DEFAULT '',
        ADD COLUMN "run_order" jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN "digest" jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN "coverlines" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_issue"
        DROP COLUMN "coverlines",
        DROP COLUMN "digest",
        DROP COLUMN "run_order",
        DROP COLUMN "theme"
    `);
  }
}
