import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A community's resource shelf (`community_resources`): the links, documents
 * and guides an owner wants every member to be able to find.
 *
 * Communities have been doing this with pinned posts, which sink as soon as
 * the feed moves. A shelf is a separate, owner-curated list with a deliberate
 * order, so `position` (ascending, default 0, ties broken by `created_at` at
 * the read site) rather than reverse-chronological.
 *
 * The community FK CASCADEs: the shelf has no meaning without the room. The
 * author FK is `ON DELETE SET NULL`, the actor-reference convention this
 * module follows, so an owner erasing their account does not take the
 * community's shelf with them.
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty here, so the
 * index builds on nothing and the file stays inside one transaction.
 */
export class AddCommunityResources1793840000000 implements MigrationInterface {
  name = 'AddCommunityResources1793840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_resources_kind_enum" AS ENUM
        ('link', 'doc', 'guide')
    `);
    await queryRunner.query(`
      CREATE TABLE "community_resources" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "title" character varying NOT NULL,
        "url" character varying NOT NULL,
        "note" text,
        "kind" "community_resources_kind_enum" NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_resources" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_resources_community" FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_resources_created_by" FOREIGN KEY ("created_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_community_resources_community_id"
        ON "community_resources" ("community_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_resources"`);
    await queryRunner.query(`DROP TYPE "community_resources_kind_enum"`);
  }
}
