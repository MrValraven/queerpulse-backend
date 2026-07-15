import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supports the flat `community-posts` alias (Task 3.2):
 *
 * 1. Adds a reserved `'like'` value to `community_post_reactions_key_enum`,
 *    so `POST /community-posts/:id/like` can model a like as a dedicated
 *    reaction row that coexists with the existing heart/celebrate/support/
 *    fire keys (excluded from `ReactionDto`'s allowlist + the 4-key summary
 *    in `community-response.ts`, so it never surfaces through the nested
 *    reaction API/response shape).
 * 2. Drops the `NOT NULL` constraint on `community_posts.community_id`, so
 *    `POST /community-posts` can create a "flat"/global post (no
 *    `communitySlug`) that isn't scoped to any community's roster. The
 *    existing `FK_community_posts_community_id` foreign key is untouched —
 *    Postgres foreign keys don't apply to NULL values, so nothing else needs
 *    to change.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddCommunityPostLikes1782800220000 implements MigrationInterface {
  name = 'AddCommunityPostLikes1782800220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_post_reactions_key_enum" ADD VALUE IF NOT EXISTS 'like'`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ALTER COLUMN "community_id" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Global posts (community_id IS NULL) can't exist once the column is
    // NOT NULL again — cascades to their reactions/replies via the existing
    // ON DELETE CASCADE foreign keys.
    await queryRunner.query(
      `DELETE FROM "community_posts" WHERE "community_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ALTER COLUMN "community_id" SET NOT NULL`,
    );

    // Postgres can't drop a single enum value directly: recreate the type
    // without it, repointing the column, then swap names.
    await queryRunner.query(
      `DELETE FROM "community_post_reactions" WHERE "key" = 'like'`,
    );
    await queryRunner.query(
      `CREATE TYPE "community_post_reactions_key_enum_old" AS ENUM('heart', 'celebrate', 'support', 'fire')`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_reactions" ALTER COLUMN "key" TYPE "community_post_reactions_key_enum_old" USING "key"::text::"community_post_reactions_key_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "community_post_reactions_key_enum"`);
    await queryRunner.query(
      `ALTER TYPE "community_post_reactions_key_enum_old" RENAME TO "community_post_reactions_key_enum"`,
    );
  }
}
