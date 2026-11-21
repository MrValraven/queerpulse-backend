// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Community setup checklist: `communities.setup_checklist_dismissed_at` records
 * when staff first dismissed the setup checklist card. NULL means the card is
 * still open.
 *
 * There is no backfill, so every existing community starts with the checklist
 * open. Adding a nullable column with no default is a catalog change on
 * Postgres with no table rewrite.
 */
export class AddCommunitySetupChecklistDismissedAt1840500000000 implements MigrationInterface {
  name = 'AddCommunitySetupChecklistDismissedAt1840500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "setup_checklist_dismissed_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "setup_checklist_dismissed_at"`,
    );
  }
}
