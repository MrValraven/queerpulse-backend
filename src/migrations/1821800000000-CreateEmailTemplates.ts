// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The email template library: admin-written emails staff copy and send by hand.
 * Shaped after `CreateModResponseTemplates1794620000000`.
 */
export class CreateEmailTemplates1821800000000 implements MigrationInterface {
  name = 'CreateEmailTemplates1821800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "label" character varying(120) NOT NULL,
        "purpose" character varying(40) NOT NULL,
        "locales" jsonb NOT NULL,
        "sort_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by_user_id" uuid,
        "updated_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_templates_label" ON "email_templates" ("label")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_templates_active_purpose"
         ON "email_templates" ("is_active", "purpose")`,
    );
    await queryRunner.query(`
      ALTER TABLE "email_templates"
        ADD CONSTRAINT "FK_email_templates_created_by_user_id"
        FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "email_templates"
        ADD CONSTRAINT "FK_email_templates_updated_by_user_id"
        FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_templates" DROP CONSTRAINT "FK_email_templates_updated_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_templates" DROP CONSTRAINT "FK_email_templates_created_by_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_email_templates_active_purpose"`);
    await queryRunner.query(`DROP INDEX "UQ_email_templates_label"`);
    await queryRunner.query(`DROP TABLE "email_templates"`);
  }
}
