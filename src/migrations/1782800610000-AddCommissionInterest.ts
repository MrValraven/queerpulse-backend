import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `culture` module's only table: `commission_interest`, backing
 * `POST /commissions/interest` (see `src/culture/`). The Culture page
 * (`queerpulse/src/features/culture/`) is otherwise curated editorial
 * content (club picks, art showcase, radio) with no server-backed listing —
 * this is the one genuine member-submitted data point on the page (the
 * "Express interest" form on a Commission Board project).
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddCommissionInterest1782800610000
  implements MigrationInterface
{
  name = 'AddCommissionInterest1782800610000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "commission_interest_commission_category_enum" AS ENUM (
        'Photo', 'Music', 'Writing', 'Design', 'Film'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "commission_interest" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "member_id" uuid NOT NULL,
        "commission_title" character varying(500) NOT NULL,
        "commission_category" "commission_interest_commission_category_enum" NOT NULL,
        "recipient_name" character varying(200) NOT NULL,
        "message" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commission_interest" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_commission_interest_member_id" ON "commission_interest" ("member_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "commission_interest" ADD CONSTRAINT "FK_commission_interest_member_id"
        FOREIGN KEY ("member_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "commission_interest" DROP CONSTRAINT "FK_commission_interest_member_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_commission_interest_member_id"`);
    await queryRunner.query(`DROP TABLE "commission_interest"`);
    await queryRunner.query(
      `DROP TYPE "commission_interest_commission_category_enum"`,
    );
  }
}
