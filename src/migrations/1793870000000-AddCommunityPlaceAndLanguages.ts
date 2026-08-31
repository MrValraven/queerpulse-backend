import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a community meets and what languages it runs in: `city`, `area`,
 * `is_online`, `languages`.
 *
 * Discover could sort communities but could not answer the two questions
 * people actually arrive with: is there one near me, and can I speak in it.
 * `is_online` is independent of `city`/`area` rather than exclusive with them,
 * because a local group that also meets on a call is genuinely both, and
 * modelling online as "no city" would hide it from everyone.
 *
 * `IDX_communities_languages` is a GIN index backing the
 * `c.languages && :languages` overlap filter. It lives HERE, in the migration,
 * and not in an `@Index` decorator on the entity, because TypeORM's decorator
 * cannot express an array/GIN operator class. That is the exact precedent set
 * by `communities.tags` (`AddCommunityTags1793300000000`) and
 * `ForumThread.tags`, and the entity's column comment says so.
 *
 * `IDX_communities_city` is a plain btree for the equality filter on city.
 *
 * Plain (blocking, non-`CONCURRENTLY`) `CREATE INDEX` on both, mirroring
 * `AddCommunityTags`: the new columns are constant-defaulted, so `ADD COLUMN`
 * is metadata-only, both indexes are built over columns that are empty in
 * every existing row, and keeping the file transactional means a failure rolls
 * back cleanly.
 */
export class AddCommunityPlaceAndLanguages1793870000000 implements MigrationInterface {
  name = 'AddCommunityPlaceAndLanguages1793870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "city" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "area" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "is_online" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "languages" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_communities_languages" ON "communities" USING gin ("languages")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_communities_city" ON "communities" ("city")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_communities_city"`);
    await queryRunner.query(`DROP INDEX "IDX_communities_languages"`);
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "languages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "is_online"`,
    );
    await queryRunner.query(`ALTER TABLE "communities" DROP COLUMN "area"`);
    await queryRunner.query(`ALTER TABLE "communities" DROP COLUMN "city"`);
  }
}
