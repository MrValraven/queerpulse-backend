import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `subprofiles` module's two tables (design spec §3): `subprofiles`
 * (one per professional persona a member runs — up to 12, linked or
 * pseudonymously unlinked) and the flat `subprofile_items` (a generalized
 * `WorkItem`, discriminated by a `section` enum). See
 * `src/subprofiles/entities/*.entity.ts` and `src/subprofiles/subprofile-kinds.ts`.
 *
 * Enum names, column names, and constraints match GLOBAL CONTRACT C1–C4 so the
 * API (Task A2) and the frontend (Task B1) line up. Both FKs cascade on
 * account/parent deletion.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddSubprofiles1782800650000 implements MigrationInterface {
  name = 'AddSubprofiles1782800650000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enums ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TYPE "subprofiles_kind_enum" AS ENUM (
        'developer', 'writer', 'musician', 'visual_artist',
        'filmmaker', 'designer', 'maker', 'generic'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "subprofiles_link_visibility_enum" AS ENUM ('linked', 'unlinked')
    `);
    await queryRunner.query(`
      CREATE TYPE "subprofiles_visibility_enum" AS ENUM ('open', 'network', 'private')
    `);
    await queryRunner.query(`
      CREATE TYPE "subprofiles_status_enum" AS ENUM ('draft', 'published')
    `);
    await queryRunner.query(`
      CREATE TYPE "subprofile_items_section_enum" AS ENUM (
        'projects', 'open_source',
        'publications', 'readings',
        'discography', 'gigs',
        'portfolio', 'exhibitions',
        'filmography', 'screenings',
        'selected_work', 'clients',
        'collections', 'workshops',
        'showcase',
        'links'
      )
    `);

    // --- tables --------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "subprofiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "kind" "subprofiles_kind_enum" NOT NULL,
        "slug" character varying NOT NULL,
        "handle" character varying,
        "display_name" character varying NOT NULL,
        "avatar_url" character varying,
        "tagline" character varying,
        "bio" text,
        "link_visibility" "subprofiles_link_visibility_enum" NOT NULL DEFAULT 'linked',
        "visibility" "subprofiles_visibility_enum" NOT NULL DEFAULT 'open',
        "status" "subprofiles_status_enum" NOT NULL DEFAULT 'draft',
        "position" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofiles" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "subprofile_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "section" "subprofile_items_section_enum" NOT NULL,
        "title" character varying NOT NULL,
        "subtitle" character varying,
        "description" text,
        "url" character varying,
        "image_url" character varying,
        "date" character varying,
        "meta" character varying,
        "tags" text[] NOT NULL DEFAULT '{}',
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_subprofile_items" PRIMARY KEY ("id")
      )
    `);

    // --- indexes -------------------------------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofiles_user_id" ON "subprofiles" ("user_id")`,
    );
    // Global handle uniqueness, but only for personas that have claimed one
    // (unlinked + published). Draft/linked rows keep handle NULL.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_subprofiles_handle" ON "subprofiles" ("handle") WHERE "handle" IS NOT NULL`,
    );
    // Per-owner slug uniqueness for the nested `/members/<main>/<slug>` URL.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_subprofiles_user_slug" ON "subprofiles" ("user_id", "slug")`,
    );
    // Directory queries filter unlinked+published+open cards by kind.
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofiles_directory" ON "subprofiles" ("kind", "status", "visibility")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_items_subprofile_id" ON "subprofile_items" ("subprofile_id")`,
    );

    // --- foreign keys --------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "subprofiles" ADD CONSTRAINT "FK_subprofiles_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "subprofile_items" ADD CONSTRAINT "FK_subprofile_items_subprofile_id"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_items" DROP CONSTRAINT "FK_subprofile_items_subprofile_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP CONSTRAINT "FK_subprofiles_user_id"`,
    );

    await queryRunner.query(`DROP INDEX "IDX_subprofile_items_subprofile_id"`);
    await queryRunner.query(`DROP INDEX "IDX_subprofiles_directory"`);
    await queryRunner.query(`DROP INDEX "UQ_subprofiles_user_slug"`);
    await queryRunner.query(`DROP INDEX "UQ_subprofiles_handle"`);
    await queryRunner.query(`DROP INDEX "IDX_subprofiles_user_id"`);

    await queryRunner.query(`DROP TABLE "subprofile_items"`);
    await queryRunner.query(`DROP TABLE "subprofiles"`);

    await queryRunner.query(`DROP TYPE "subprofile_items_section_enum"`);
    await queryRunner.query(`DROP TYPE "subprofiles_status_enum"`);
    await queryRunner.query(`DROP TYPE "subprofiles_visibility_enum"`);
    await queryRunner.query(`DROP TYPE "subprofiles_link_visibility_enum"`);
    await queryRunner.query(`DROP TYPE "subprofiles_kind_enum"`);
  }
}
