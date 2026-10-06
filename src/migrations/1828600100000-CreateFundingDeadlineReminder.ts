// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Funding & Grants (P3): the reminder ledger (`FundingDeadlineReminder`).
 *
 * The primary key over (user, thread, stage, deadline) is the spec's unique
 * constraint and the sweeper's claim: an insert that conflicts sends nothing.
 * It leads with `user_id`, which serves the users cascade; the thread cascade
 * gets its own index.
 */
export class CreateFundingDeadlineReminder1828600100000 implements MigrationInterface {
  name = 'CreateFundingDeadlineReminder1828600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "funding_deadline_reminder" (
        "user_id" uuid NOT NULL,
        "thread_id" uuid NOT NULL,
        "stage" character varying(4) NOT NULL,
        "deadline" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "sent_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_funding_deadline_reminder"
          PRIMARY KEY ("user_id", "thread_id", "stage", "deadline"),
        CONSTRAINT "CHK_funding_deadline_reminder_stage"
          CHECK ("stage" IN ('7d', '1d')),
        CONSTRAINT "FK_funding_deadline_reminder_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_funding_deadline_reminder_thread_id" FOREIGN KEY ("thread_id")
          REFERENCES "forum_thread"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_funding_deadline_reminder_thread_id"
        ON "funding_deadline_reminder" ("thread_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "funding_deadline_reminder"`);
  }
}
