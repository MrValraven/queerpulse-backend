import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds curated tags to communities (spec: curated Community tags): a
 * `text[]` column defaulting to the empty array, plus a GIN index so the
 * list query's `c.tags && :tags` overlap filter (see
 * `CommunitiesService.list`) can be served by an index scan instead of a
 * sequential scan as the table grows.
 *
 * Mirrors `AddForumThreadTags1785901000000` exactly, down to the plain
 * (blocking, non-`CONCURRENTLY`) `CREATE INDEX`: the column default is a
 * constant, so `ADD COLUMN` is a fast metadata-only change on modern
 * Postgres, and keeping it transactional means a failure rolls the whole
 * thing back cleanly. Unlike forum thread tags, `communities.tags` is
 * curated (validated against `COMMUNITY_TAGS` at the DTO layer), not
 * freeform — see `src/communities/community-tags.ts`.
 */
export class AddCommunityTags1793300000000 implements MigrationInterface {
  name = 'AddCommunityTags1793300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "tags" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_communities_tags" ON "communities" USING gin ("tags")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_communities_tags"`);
    await queryRunner.query(`ALTER TABLE "communities" DROP COLUMN "tags"`);
  }
}
