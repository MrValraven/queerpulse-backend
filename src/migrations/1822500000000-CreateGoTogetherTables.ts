// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Go together (design spec 2026-09-28, section 6). Every user FK cascades:
 * this is member-private data, and account erasure deletes the user row and
 * relies on the cascade. `match_training_rows` holds no identifiers at all.
 */
export class CreateGoTogetherTables1822500000000 implements MigrationInterface {
  name = 'CreateGoTogetherTables1822500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "friend_match_profiles" (
        "user_id" uuid NOT NULL,
        "answers" jsonb NOT NULL,
        "questionnaire_version" integer NOT NULL,
        "consented_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_friend_match_profiles" PRIMARY KEY ("user_id"),
        CONSTRAINT "FK_friend_match_profiles_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "event_match_configs" (
        "event_id" uuid NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "cutoff_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "host_questions" jsonb NOT NULL DEFAULT '[]',
        "meeting_point_note" character varying(200),
        "matched_at" TIMESTAMP WITH TIME ZONE,
        "late_group_at" TIMESTAMP WITH TIME ZONE,
        "feedback_prompted_at" TIMESTAMP WITH TIME ZONE,
        "run_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_match_configs" PRIMARY KEY ("event_id"),
        CONSTRAINT "FK_event_match_configs_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_event_match_configs_due" ON "event_match_configs" ("cutoff_at")
      WHERE "enabled" = true AND "matched_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "event_match_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "conversation_id" uuid,
        "band" character varying(16) NOT NULL,
        "reasons" jsonb NOT NULL DEFAULT '[]',
        "scoring_version" integer NOT NULL,
        "solver_seed_label" character varying(80) NOT NULL,
        "pair_components" jsonb,
        "formed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "dissolved_at" TIMESTAMP WITH TIME ZONE,
        "training_written_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_event_match_groups" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_event_match_groups_band" CHECK ("band" IN ('strong', 'good')),
        CONSTRAINT "FK_event_match_groups_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_match_groups_conversation" FOREIGN KEY ("conversation_id")
          REFERENCES "conversations"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_match_groups_event_id" ON "event_match_groups" ("event_id")`,
    );
    await queryRunner.query(`
      CREATE INDEX "IDX_event_match_groups_conversation_id" ON "event_match_groups" ("conversation_id")
      WHERE "conversation_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "event_match_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "pair_partner_id" uuid,
        "pair_status" character varying(16) NOT NULL DEFAULT 'none',
        "host_answers" jsonb NOT NULL DEFAULT '{}',
        "lens" character varying(24),
        "lens_consented_at" TIMESTAMP WITH TIME ZONE,
        "status" character varying(16) NOT NULL DEFAULT 'waiting',
        "group_id" uuid,
        "merge_offer_group_id" uuid,
        "checked_in_at" TIMESTAMP WITH TIME ZONE,
        "left_event_at" TIMESTAMP WITH TIME ZONE,
        "unmatched_notified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_match_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_match_entries_event_user" UNIQUE ("event_id", "user_id"),
        CONSTRAINT "CHK_event_match_entries_status"
          CHECK ("status" IN ('waiting', 'grouped', 'unmatched', 'withdrawn')),
        CONSTRAINT "CHK_event_match_entries_pair_status"
          CHECK ("pair_status" IN ('none', 'pending', 'accepted')),
        CONSTRAINT "CHK_event_match_entries_lens"
          CHECK ("lens" IS NULL OR "lens" IN ('transNonBinary', 'womenFemmes', 'queerPoc')),
        CONSTRAINT "FK_event_match_entries_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_match_entries_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_match_entries_pair_partner" FOREIGN KEY ("pair_partner_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_event_match_entries_group" FOREIGN KEY ("group_id")
          REFERENCES "event_match_groups"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_event_match_entries_merge_offer_group" FOREIGN KEY ("merge_offer_group_id")
          REFERENCES "event_match_groups"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_match_entries_event_status" ON "event_match_entries" ("event_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_match_entries_user_id" ON "event_match_entries" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_match_entries_pair_partner_id" ON "event_match_entries" ("pair_partner_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_match_entries_group_id" ON "event_match_entries" ("group_id")`,
    );
    await queryRunner.query(`
      CREATE INDEX "IDX_event_match_entries_merge_offer_group_id" ON "event_match_entries" ("merge_offer_group_id")
      WHERE "merge_offer_group_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "match_feedback" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "group_id" uuid NOT NULL,
        "rater_id" uuid NOT NULL,
        "ratee_id" uuid NOT NULL,
        "verdict" character varying(8) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_match_feedback_group_rater_ratee" UNIQUE ("group_id", "rater_id", "ratee_id"),
        CONSTRAINT "CHK_match_feedback_verdict" CHECK ("verdict" IN ('yes', 'maybe', 'no')),
        CONSTRAINT "FK_match_feedback_group" FOREIGN KEY ("group_id")
          REFERENCES "event_match_groups"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_feedback_rater" FOREIGN KEY ("rater_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_feedback_ratee" FOREIGN KEY ("ratee_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    // "group_id" lookups use the unique constraint's leading column.
    await queryRunner.query(
      `CREATE INDEX "IDX_match_feedback_rater_id" ON "match_feedback" ("rater_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_match_feedback_ratee_id" ON "match_feedback" ("ratee_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "match_group_feedback" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "group_id" uuid NOT NULL,
        "rater_id" uuid NOT NULL,
        "clicked" character varying(8),
        "go_again" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_group_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_match_group_feedback_group_rater" UNIQUE ("group_id", "rater_id"),
        CONSTRAINT "CHK_match_group_feedback_clicked"
          CHECK ("clicked" IS NULL OR "clicked" IN ('yes', 'somewhat', 'no')),
        CONSTRAINT "FK_match_group_feedback_group" FOREIGN KEY ("group_id")
          REFERENCES "event_match_groups"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_group_feedback_rater" FOREIGN KEY ("rater_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_match_group_feedback_rater_id" ON "match_group_feedback" ("rater_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "match_avoidances" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "avoided_user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_avoidances" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_match_avoidances_pair" UNIQUE ("user_id", "avoided_user_id"),
        CONSTRAINT "FK_match_avoidances_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_avoidances_avoided_user" FOREIGN KEY ("avoided_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_match_avoidances_avoided_user_id" ON "match_avoidances" ("avoided_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "match_training_rows" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "scoring_version" integer NOT NULL,
        "components" jsonb NOT NULL,
        "mutual_yes" boolean NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_training_rows" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "event_match_group_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations" ADD CONSTRAINT "FK_conversations_event_match_group"
        FOREIGN KEY ("event_match_group_id") REFERENCES "event_match_groups"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_event_match_group_id" ON "conversations" ("event_match_group_id")
      WHERE "event_match_group_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_conversations_event_match_group_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_event_match_group"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "event_match_group_id"`,
    );
    await queryRunner.query(`DROP TABLE "match_training_rows"`);
    await queryRunner.query(`DROP TABLE "match_avoidances"`);
    await queryRunner.query(`DROP TABLE "match_group_feedback"`);
    await queryRunner.query(`DROP TABLE "match_feedback"`);
    await queryRunner.query(`DROP TABLE "event_match_entries"`);
    await queryRunner.query(`DROP TABLE "event_match_groups"`);
    await queryRunner.query(`DROP TABLE "event_match_configs"`);
    await queryRunner.query(`DROP TABLE "friend_match_profiles"`);
  }
}
