// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubprofileItemFeatured1785000260000 implements MigrationInterface {
  name = 'AddSubprofileItemFeatured1785000260000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_items" ADD "is_featured" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_items" DROP COLUMN "is_featured"`,
    );
  }
}
