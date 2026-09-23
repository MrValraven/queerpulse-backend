// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListingCreatedByStaffId1821300100000 implements MigrationInterface {
  name = 'AddListingCreatedByStaffId1821300100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "created_by_staff_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_created_by_staff_id" ON "listings" ("created_by_staff_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD CONSTRAINT "FK_listings_created_by_staff" FOREIGN KEY ("created_by_staff_id") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP CONSTRAINT "FK_listings_created_by_staff"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_listings_created_by_staff_id"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "created_by_staff_id"`,
    );
  }
}
