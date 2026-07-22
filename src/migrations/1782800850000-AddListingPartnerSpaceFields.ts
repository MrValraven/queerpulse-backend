import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListingPartnerSpaceFields1782800850000 implements MigrationInterface {
  name = 'AddListingPartnerSpaceFields1782800850000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "is_partnered_with_queerpulse" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "space_type" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(`ALTER TABLE "listings" ADD "capacity" integer`);
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "host_note" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_is_partnered_with_queerpulse" ON "listings" ("is_partnered_with_queerpulse")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_listings_is_partnered_with_queerpulse"`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "host_note"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "capacity"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "space_type"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "is_partnered_with_queerpulse"`,
    );
  }
}
