import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubprofileSkinData1786002101000 implements MigrationInterface {
  name = 'AddSubprofileSkinData1786002101000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD COLUMN "skin_data" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP COLUMN "skin_data"`,
    );
  }
}
