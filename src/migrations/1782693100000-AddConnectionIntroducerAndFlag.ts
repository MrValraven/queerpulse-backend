import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConnectionIntroducerAndFlag1782693100000
  implements MigrationInterface
{
  name = 'AddConnectionIntroducerAndFlag1782693100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "connections" ADD "introduced_by" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "connections" ADD CONSTRAINT "FK_connections_introduced_by"
        FOREIGN KEY ("introduced_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `ALTER TABLE "connections" ADD "flagged" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "connections" DROP COLUMN "flagged"`);
    await queryRunner.query(
      `ALTER TABLE "connections" DROP CONSTRAINT "FK_connections_introduced_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "connections" DROP COLUMN "introduced_by"`,
    );
  }
}
