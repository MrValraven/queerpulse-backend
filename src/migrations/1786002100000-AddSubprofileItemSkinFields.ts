import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubprofileItemSkinFields1786002100000 implements MigrationInterface {
  name = 'AddSubprofileItemSkinFields1786002100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subprofile_items"
        ADD COLUMN "venue" character varying(200),
        ADD COLUMN "doors" character varying(40),
        ADD COLUMN "ticket_url" character varying(1000),
        ADD COLUMN "gig_state" character varying(20),
        ADD COLUMN "medium" character varying(120),
        ADD COLUMN "dimensions" character varying(80),
        ADD COLUMN "edition" character varying(80),
        ADD COLUMN "work_state" character varying(20),
        ADD COLUMN "structured" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subprofile_items"
        DROP COLUMN "structured",
        DROP COLUMN "work_state",
        DROP COLUMN "edition",
        DROP COLUMN "dimensions",
        DROP COLUMN "medium",
        DROP COLUMN "gig_state",
        DROP COLUMN "ticket_url",
        DROP COLUMN "doors",
        DROP COLUMN "venue"
    `);
  }
}
