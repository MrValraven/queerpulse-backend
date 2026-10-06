// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `conversations.invite_token_max_uses` and
 * `conversations.invite_token_use_count` (PRD-400, use cap): a group's
 * join-by-link token can now seat at most N newcomers (1, 5 or 25, chosen by
 * the owner or admin when the link is created or reset). NULL max uses means
 * unlimited, which is what every link live at deploy time keeps, so no
 * backfill is needed: existing links behave exactly as before. The use count
 * starts at 0 for every row.
 */
export class AddGroupInviteTokenUseCap1830040000000 implements MigrationInterface {
  name = 'AddGroupInviteTokenUseCap1830040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "invite_token_max_uses" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "invite_token_use_count" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "invite_token_use_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "invite_token_max_uses"`,
    );
  }
}
