// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-423 (opaque member keys): a block placed from inside a matched Go
 * together chat, by per-chat member key (`MatchedChatMembersService`) or from
 * the group sheet (`GoTogetherGroupService`), records the chat it came from.
 * The blocker only ever knew that member by first name, so the block list
 * renders such a row by first name alone, with no slug, and unblocks it by
 * block id. Null for every ordinary block, which reads exactly as before.
 *
 * No foreign key: a deleted chat must leave the row anonymous, and an
 * `ON DELETE SET NULL` would turn it back into a named block.
 */
export class AddBlocksMatchedConversationId1830095000000 implements MigrationInterface {
  name = 'AddBlocksMatchedConversationId1830095000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "blocks" ADD "matched_conversation_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "blocks" DROP COLUMN "matched_conversation_id"`,
    );
  }
}
