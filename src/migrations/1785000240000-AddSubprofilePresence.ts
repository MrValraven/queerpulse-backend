import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 of subprofiles identity & presence: adds 5 nullable presence
 * columns to `subprofiles` (cover image, curated accent key, availability
 * status, and an external contact CTA label/url) plus the new
 * `subprofile_social_links` table — a persona-scoped mirror of `social_links`
 * (main profile). See `src/subprofiles/entities/subprofile.entity.ts` and
 * `src/subprofiles/entities/subprofile-social-link.entity.ts`.
 */
export class AddSubprofilePresence1785000240000 implements MigrationInterface {
  name = 'AddSubprofilePresence1785000240000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- subprofiles: presence columns ---------------------------------------
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD "cover_url" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD "accent" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD "availability" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD "cta_label" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD "cta_url" character varying`,
    );

    // --- subprofile_social_links table ---------------------------------------
    await queryRunner.query(`
      CREATE TABLE "subprofile_social_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "platform" character varying NOT NULL,
        "url_or_handle" character varying NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_subprofile_social_links" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_social_links_subprofile_id" ON "subprofile_social_links" ("subprofile_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "subprofile_social_links" ADD CONSTRAINT "FK_subprofile_social_links_subprofile_id"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_social_links" DROP CONSTRAINT "FK_subprofile_social_links_subprofile_id"`,
    );

    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_social_links_subprofile_id"`,
    );

    await queryRunner.query(`DROP TABLE "subprofile_social_links"`);

    await queryRunner.query(`ALTER TABLE "subprofiles" DROP COLUMN "cta_url"`);
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP COLUMN "cta_label"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP COLUMN "availability"`,
    );
    await queryRunner.query(`ALTER TABLE "subprofiles" DROP COLUMN "accent"`);
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP COLUMN "cover_url"`,
    );
  }
}
