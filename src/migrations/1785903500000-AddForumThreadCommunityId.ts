import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `forum_thread.community_id` — an optional link from a forum thread to
 * the community it belongs to, so a community's page can show its own forum
 * threads (part of "Personalized Community Pulse"). Nullable: threads aren't
 * required to be tied to a specific community. Table name is `forum_thread`
 * (singular), matching `ForumThread`'s `@Entity('forum_thread')`.
 */
export class AddForumThreadCommunityId1785903500000 implements MigrationInterface {
  name = 'AddForumThreadCommunityId1785903500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "community_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_community_id" ON "forum_thread" ("community_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_forum_thread_community_id"`);
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "community_id"`,
    );
  }
}
