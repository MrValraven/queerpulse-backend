import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileRichDetail1782692500000 implements MigrationInterface {
  name = 'AddProfileRichDetail1782692500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- profiles: new scalar columns ---
    await queryRunner.query(`
      ALTER TABLE "profiles"
        ADD COLUMN "verified" boolean NOT NULL DEFAULT false,
        ADD COLUMN "now" text,
        ADD COLUMN "joined_at" timestamptz NOT NULL DEFAULT now()
    `);

    // --- enum types ---
    await queryRunner.query(
      `CREATE TYPE "board_posts_kind_enum" AS ENUM ('looking', 'offering')`,
    );
    await queryRunner.query(
      `CREATE TYPE "shapings_kind_enum" AS ENUM ('film', 'book', 'song', 'moment')`,
    );
    await queryRunner.query(
      `CREATE TYPE "activities_kind_enum" AS ENUM ('post', 'event', 'message', 'reading', 'edit', 'photo', 'music')`,
    );

    // --- skills ---
    await queryRunner.query(`
      CREATE TABLE "skills" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "meta" character varying NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_skills" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_skills_user_id" ON "skills" ("user_id")`,
    );

    // --- board_posts ---
    await queryRunner.query(`
      CREATE TABLE "board_posts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "kind" "board_posts_kind_enum" NOT NULL,
        "title" character varying NOT NULL,
        "slug" character varying NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_board_posts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_board_posts_user_id" ON "board_posts" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_board_posts_user_slug" ON "board_posts" ("user_id", "slug")`,
    );

    // --- shapings ---
    await queryRunner.query(`
      CREATE TABLE "shapings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "kind" "shapings_kind_enum" NOT NULL,
        "title" character varying NOT NULL,
        "note" text NOT NULL,
        CONSTRAINT "PK_shapings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_shapings_user_id" ON "shapings" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_shapings_user_kind" ON "shapings" ("user_id", "kind")`,
    );

    // --- activities ---
    await queryRunner.query(`
      CREATE TABLE "activities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "kind" "activities_kind_enum" NOT NULL,
        "title" character varying NOT NULL,
        "sub" character varying,
        "to_link" character varying,
        "occurred_at" timestamptz NOT NULL,
        CONSTRAINT "PK_activities" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_activities_user_id" ON "activities" ("user_id")`,
    );

    // --- groups ---
    await queryRunner.query(`
      CREATE TABLE "groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "PK_groups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_groups_slug" UNIQUE ("slug")
      )
    `);

    // --- group_memberships ---
    await queryRunner.query(`
      CREATE TABLE "group_memberships" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "group_id" uuid NOT NULL,
        "role" character varying NOT NULL,
        CONSTRAINT "PK_group_memberships" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_group_memberships_user_id" ON "group_memberships" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_group_memberships_user_group" ON "group_memberships" ("user_id", "group_id")`,
    );

    // --- foreign keys ---
    for (const t of [
      'skills',
      'board_posts',
      'shapings',
      'activities',
      'group_memberships',
    ]) {
      await queryRunner.query(`
        ALTER TABLE "${t}" ADD CONSTRAINT "FK_${t}_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      `);
    }
    await queryRunner.query(`
      ALTER TABLE "group_memberships" ADD CONSTRAINT "FK_group_memberships_group_id"
        FOREIGN KEY ("group_id") REFERENCES "groups"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "group_memberships" DROP CONSTRAINT "FK_group_memberships_group_id"`,
    );
    for (const t of [
      'group_memberships',
      'activities',
      'shapings',
      'board_posts',
      'skills',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${t}" DROP CONSTRAINT "FK_${t}_user_id"`,
      );
    }
    await queryRunner.query(`DROP TABLE "group_memberships"`);
    await queryRunner.query(`DROP TABLE "groups"`);
    await queryRunner.query(`DROP TABLE "activities"`);
    await queryRunner.query(`DROP TABLE "shapings"`);
    await queryRunner.query(`DROP TABLE "board_posts"`);
    await queryRunner.query(`DROP TABLE "skills"`);
    await queryRunner.query(`DROP TYPE "activities_kind_enum"`);
    await queryRunner.query(`DROP TYPE "shapings_kind_enum"`);
    await queryRunner.query(`DROP TYPE "board_posts_kind_enum"`);
    await queryRunner.query(`
      ALTER TABLE "profiles"
        DROP COLUMN "joined_at",
        DROP COLUMN "now",
        DROP COLUMN "verified"
    `);
  }
}
