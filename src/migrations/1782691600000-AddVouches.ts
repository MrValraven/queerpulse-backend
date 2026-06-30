import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVouches1782691600000 implements MigrationInterface {
  name = 'AddVouches1782691600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vouches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "voucher_id" uuid NOT NULL,
        "vouchee_id" uuid NOT NULL,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vouches" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_vouches_voucher_vouchee" UNIQUE ("voucher_id", "vouchee_id"),
        CONSTRAINT "CHK_vouches_no_self" CHECK ("voucher_id" <> "vouchee_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_vouches_voucher_id" ON "vouches" ("voucher_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vouches_vouchee_id" ON "vouches" ("vouchee_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "vouches" ADD CONSTRAINT "FK_vouches_voucher_id"
        FOREIGN KEY ("voucher_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "vouches" ADD CONSTRAINT "FK_vouches_vouchee_id"
        FOREIGN KEY ("vouchee_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vouches" DROP CONSTRAINT "FK_vouches_vouchee_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vouches" DROP CONSTRAINT "FK_vouches_voucher_id"`,
    );
    await queryRunner.query(`DROP TABLE "vouches"`);
  }
}
