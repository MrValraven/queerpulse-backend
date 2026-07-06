import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobs1782693400000 implements MigrationInterface {
  name = 'AddJobs1782693400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "job_format_enum" AS ENUM('remote', 'in_person', 'hybrid', 'either')`,
    );
    await queryRunner.query(
      `CREATE TYPE "job_status_enum" AS ENUM('open', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "job_applications_status_enum" AS ENUM('submitted', 'reviewing', 'accepted', 'declined')`,
    );

    await queryRunner.query(`
      CREATE TABLE "jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "company_id" uuid NOT NULL,
        "title" character varying NOT NULL,
        "category" character varying NOT NULL,
        "commitment" character varying NOT NULL,
        "seniority" character varying NOT NULL,
        "format" "job_format_enum" NOT NULL,
        "location" character varying NOT NULL,
        "city" character varying,
        "timezone" character varying,
        "salary" character varying,
        "rate_min" numeric,
        "rate_max" numeric,
        "currency" character varying,
        "rate_per" character varying,
        "hide_pay" boolean NOT NULL DEFAULT false,
        "barter" boolean NOT NULL DEFAULT false,
        "deadline" character varying,
        "start_date" character varying,
        "desc" text NOT NULL,
        "tags" text array NOT NULL DEFAULT '{}',
        "queer_run" boolean NOT NULL DEFAULT false,
        "qr_label" character varying,
        "detail" jsonb NOT NULL,
        "benefits" text array NOT NULL DEFAULT '{}',
        "inclusivity" text array NOT NULL DEFAULT '{}',
        "screening" jsonb NOT NULL DEFAULT '[]',
        "contacts" jsonb NOT NULL DEFAULT '[]',
        "email" character varying,
        "link" character varying,
        "poster_id" uuid NOT NULL,
        "status" "job_status_enum" NOT NULL DEFAULT 'open',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_jobs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_jobs_slug" ON "jobs" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_company_id" ON "jobs" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_poster_id" ON "jobs" ("poster_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "job_applications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "job_id" uuid NOT NULL,
        "applicant_id" uuid NOT NULL,
        "answers" jsonb NOT NULL DEFAULT '[]',
        "cover_note" text,
        "status" "job_applications_status_enum" NOT NULL DEFAULT 'submitted',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_job_applications" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_job_applications" UNIQUE ("job_id", "applicant_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_job_applications_job_id" ON "job_applications" ("job_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_job_applications_applicant_id" ON "job_applications" ("applicant_id")`,
    );

    // Foreign keys
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "FK_jobs_company_id" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "FK_jobs_poster_id" FOREIGN KEY ("poster_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_applications" ADD CONSTRAINT "FK_job_applications_job_id" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_applications" ADD CONSTRAINT "FK_job_applications_applicant_id" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_applications" DROP CONSTRAINT "FK_job_applications_applicant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_applications" DROP CONSTRAINT "FK_job_applications_job_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT "FK_jobs_poster_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT "FK_jobs_company_id"`,
    );

    await queryRunner.query(`DROP TABLE "job_applications"`);
    await queryRunner.query(`DROP TABLE "jobs"`);

    await queryRunner.query(`DROP TYPE "job_applications_status_enum"`);
    await queryRunner.query(`DROP TYPE "job_status_enum"`);
    await queryRunner.query(`DROP TYPE "job_format_enum"`);
  }
}
