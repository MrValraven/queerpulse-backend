// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubcommunities1821400000000 implements MigrationInterface {
  name = 'AddSubcommunities1821400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "communities" ADD "parent_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "allows_subcommunities" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "archived_with_parent" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_communities_parent_id" ON "communities" ("parent_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD CONSTRAINT "FK_communities_parent" FOREIGN KEY ("parent_id") REFERENCES "communities"("id") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" ADD CONSTRAINT "CHK_communities_space_has_no_spaces" CHECK ("parent_id" IS NULL OR "allows_subcommunities" = false)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP CONSTRAINT "CHK_communities_space_has_no_spaces"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP CONSTRAINT "FK_communities_parent"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_communities_parent_id"`);
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "archived_with_parent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "allows_subcommunities"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "parent_id"`,
    );
  }
}
