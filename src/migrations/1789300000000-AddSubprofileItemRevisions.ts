import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `subprofile_item_revisions` — one row per saved snapshot of a
 * `subprofile_items` row (Protect Your Work, revision history). `snapshot`
 * holds the full item payload at save time; `section` is copied in flat
 * (varchar, not the `subprofile_items_section_enum`) since a revision is a
 * point-in-time record and should not depend on the enum's current members.
 * See `src/subprofiles/entities/subprofile-item-revision.entity.ts`.
 *
 * UNAPPLIED — left for the maintainer to run.
 */
export class AddSubprofileItemRevisions1789300000000
  implements MigrationInterface
{
  name = 'AddSubprofileItemRevisions1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_item_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "item_id" uuid NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "section" character varying NOT NULL,
        "snapshot" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_item_revisions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_item_revisions_item_id" ON "subprofile_item_revisions" ("item_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "subprofile_item_revisions" ADD CONSTRAINT "FK_subprofile_item_revisions_item_id"
        FOREIGN KEY ("item_id") REFERENCES "subprofile_items"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_item_revisions" DROP CONSTRAINT "FK_subprofile_item_revisions_item_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_item_revisions_item_id"`,
    );
    await queryRunner.query(`DROP TABLE "subprofile_item_revisions"`);
  }
}
