// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Funding & Grants (P2): the 1:1 side table that turns a forum thread into an
 * open call or a fundraiser (`ForumThreadFunding`).
 *
 * `CHK_forum_thread_funding_one_kind` keeps the call columns and the ask
 * columns from both holding values on one row; the thread's own `kind` says
 * which half applies, and the service checks the pairing on write.
 *
 * `IDX_forum_thread_funding_deadline` is partial on dated calls only: the
 * closing view and the daily reminder sweep both range-scan it, and rolling
 * calls and asks never appear in either.
 */
export class CreateForumThreadFunding1828600000000 implements MigrationInterface {
  name = 'CreateForumThreadFunding1828600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "forum_thread_funding" (
        "thread_id" uuid NOT NULL,
        "link_url" character varying(2048) NOT NULL,
        "link_key" character varying(512) NOT NULL,
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "funder_name" character varying(120) NULL,
        "amount_min" integer NULL,
        "amount_max" integer NULL,
        "deadline" TIMESTAMP(3) WITH TIME ZONE NULL,
        "eligibility" text[] NOT NULL DEFAULT '{}',
        "scope" character varying(16) NULL,
        "goal_amount" integer NULL,
        "ask_purpose" character varying(16) NULL,
        "beneficiary" character varying(16) NULL,
        "ends_at" TIMESTAMP(3) WITH TIME ZONE NULL,
        "ended_at" TIMESTAMP(3) WITH TIME ZONE NULL,
        "ended_reason" character varying(16) NULL,
        "approved_at" TIMESTAMP(3) WITH TIME ZONE NULL,
        CONSTRAINT "PK_forum_thread_funding" PRIMARY KEY ("thread_id"),
        CONSTRAINT "FK_forum_thread_funding_thread_id" FOREIGN KEY ("thread_id")
          REFERENCES "forum_thread"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "CHK_forum_thread_funding_one_kind" CHECK (
          (
            "goal_amount" IS NULL AND "ask_purpose" IS NULL
            AND "beneficiary" IS NULL AND "ends_at" IS NULL
            AND "ended_at" IS NULL AND "ended_reason" IS NULL
            AND "approved_at" IS NULL
          )
          OR (
            "funder_name" IS NULL AND "amount_min" IS NULL
            AND "amount_max" IS NULL AND "deadline" IS NULL
            AND "scope" IS NULL AND "eligibility" = '{}'
          )
        ),
        CONSTRAINT "CHK_forum_thread_funding_amounts" CHECK (
          ("amount_min" IS NULL OR "amount_min" >= 0)
          AND ("amount_max" IS NULL OR "amount_max" >= 0)
          AND ("amount_min" IS NULL OR "amount_max" IS NULL OR "amount_max" >= "amount_min")
        ),
        CONSTRAINT "CHK_forum_thread_funding_goal" CHECK (
          "goal_amount" IS NULL OR "goal_amount" > 0
        ),
        CONSTRAINT "CHK_forum_thread_funding_ended_reason" CHECK (
          "ended_reason" IS NULL OR "ended_reason" IN ('goal_reached', 'closed')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_funding_link_key"
        ON "forum_thread_funding" ("link_key")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_funding_deadline"
        ON "forum_thread_funding" ("deadline")
        WHERE "deadline" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "forum_thread_funding"`);
  }
}
