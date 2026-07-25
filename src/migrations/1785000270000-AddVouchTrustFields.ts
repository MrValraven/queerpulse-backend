import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVouchTrustFields1785000270000 implements MigrationInterface {
  name = 'AddVouchTrustFields1785000270000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "vouches_relationship_enum" AS ENUM('collaborated', 'friends', 'group', 'met_through', 'neighbours')`,
    );
    await queryRunner.query(
      `ALTER TABLE "vouches"
         ADD "relationship" "vouches_relationship_enum",
         ADD "anonymous" boolean NOT NULL DEFAULT false,
         ADD "withdrawn_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vouches_withdrawn_at" ON "vouches" ("withdrawn_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "private_network" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP COLUMN "private_network"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_vouches_withdrawn_at"`);
    await queryRunner.query(
      `ALTER TABLE "vouches"
         DROP COLUMN "withdrawn_at",
         DROP COLUMN "anonymous",
         DROP COLUMN "relationship"`,
    );
    await queryRunner.query(`DROP TYPE "vouches_relationship_enum"`);
  }
}
