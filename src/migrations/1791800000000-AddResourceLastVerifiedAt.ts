import { MigrationInterface, QueryRunner } from 'typeorm';

// CNT-13: freshness signal for the guide library. Resources are editorial
// content (SNS pathways, statute references, hotline numbers) that goes
// stale — readers currently have no way to tell a guide was checked last
// week from one checked two years ago. `last_verified_at` is set by hand
// during editorial review; NULL means never verified. No backfill on
// existing rows — fabricating a historical verification date would be
// dishonest, so every existing row stays NULL until an editor actually
// reviews it, and the FE renders that as "not yet verified" rather than a
// fake date.
export class AddResourceLastVerifiedAt1791800000000 implements MigrationInterface {
  name = 'AddResourceLastVerifiedAt1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "resources"
        ADD COLUMN "last_verified_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "resources"
        DROP COLUMN "last_verified_at"
    `);
  }
}
