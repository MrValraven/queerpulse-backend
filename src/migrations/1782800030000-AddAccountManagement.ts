import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountManagement1782800030000 implements MigrationInterface {
  name = 'AddAccountManagement1782800030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- deletion_request ----------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "deletion_request_status_enum" AS ENUM('grace', 'processing', 'erased', 'cancelled')`,
    );
    await queryRunner.query(`
      CREATE TABLE "deletion_request" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "status" "deletion_request_status_enum" NOT NULL,
        "scheduled_for" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deletion_request" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_deletion_request_user_id" ON "deletion_request" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_request" ADD CONSTRAINT "FK_deletion_request_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- dsar_request ----------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "dsar_request_status_enum" AS ENUM('received', 'in_review', 'resolved', 'rejected')`,
    );
    await queryRunner.query(`
      CREATE TABLE "dsar_request" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "reference" character varying NOT NULL,
        "article" smallint NOT NULL,
        "status" "dsar_request_status_enum" NOT NULL DEFAULT 'received',
        "scopes" jsonb NOT NULL,
        "details" text NOT NULL,
        "context" character varying,
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "due_by" TIMESTAMP WITH TIME ZONE NOT NULL,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_dsar_request" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_dsar_request_article" CHECK ("article" IN (15, 16, 17, 21))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_dsar_request_reference" ON "dsar_request" ("reference")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dsar_request_user_id" ON "dsar_request" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "dsar_request" ADD CONSTRAINT "FK_dsar_request_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- data_export_job ---------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "data_export_job_status_enum" AS ENUM('queued', 'processing', 'ready', 'failed', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "data_export_job_format_enum" AS ENUM('json', 'csv', 'both')`,
    );
    await queryRunner.query(`
      CREATE TABLE "data_export_job" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "status" "data_export_job_status_enum" NOT NULL DEFAULT 'queued',
        "categories" jsonb NOT NULL,
        "format" "data_export_job_format_enum" NOT NULL,
        "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "generated_at" TIMESTAMP WITH TIME ZONE,
        "data" jsonb,
        "error" character varying,
        CONSTRAINT "PK_data_export_job" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_data_export_job_user_id" ON "data_export_job" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "data_export_job" ADD CONSTRAINT "FK_data_export_job_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- email_preference --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "email_preference" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "category" character varying NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_preference" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_preference_user_id_category" ON "email_preference" ("user_id", "category")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_preference_user_id" ON "email_preference" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_preference" ADD CONSTRAINT "FK_email_preference_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- account_reauth_token --------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "account_reauth_token" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "token" character varying NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_account_reauth_token" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_account_reauth_token_token" ON "account_reauth_token" ("token")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_reauth_token_user_id" ON "account_reauth_token" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_reauth_token" ADD CONSTRAINT "FK_account_reauth_token_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- account_deactivation -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "account_deactivation" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "deactivated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reactivated_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_account_deactivation" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_account_deactivation_user_id" ON "account_deactivation" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_deactivation" ADD CONSTRAINT "FK_account_deactivation_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_deactivation" DROP CONSTRAINT "FK_account_deactivation_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "account_deactivation"`);

    await queryRunner.query(
      `ALTER TABLE "account_reauth_token" DROP CONSTRAINT "FK_account_reauth_token_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "account_reauth_token"`);

    await queryRunner.query(
      `ALTER TABLE "email_preference" DROP CONSTRAINT "FK_email_preference_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "email_preference"`);

    await queryRunner.query(
      `ALTER TABLE "data_export_job" DROP CONSTRAINT "FK_data_export_job_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "data_export_job"`);
    await queryRunner.query(`DROP TYPE "data_export_job_format_enum"`);
    await queryRunner.query(`DROP TYPE "data_export_job_status_enum"`);

    await queryRunner.query(
      `ALTER TABLE "dsar_request" DROP CONSTRAINT "FK_dsar_request_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "dsar_request"`);
    await queryRunner.query(`DROP TYPE "dsar_request_status_enum"`);

    await queryRunner.query(
      `ALTER TABLE "deletion_request" DROP CONSTRAINT "FK_deletion_request_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "deletion_request"`);
    await queryRunner.query(`DROP TYPE "deletion_request_status_enum"`);
  }
}
