import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListingCoordinates1785000710000 implements MigrationInterface {
  name = 'AddListingCoordinates1785000710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "latitude" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "longitude" double precision`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "longitude"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "latitude"`);
  }
}
