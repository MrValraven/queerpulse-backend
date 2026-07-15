import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reports` (member-filed reports against a member/post/reply/venue/message/
 * community) backing `src/reports`, plus `appeals` and `mod_audit_logs`
 * backing `src/moderation` (spec §3 Tier 1 "reports" + "moderation").
 * Mirrors `AddPartners1782693600000`'s enum/table/index/FK shape.
 *
 * Reconciled against the frontend's *live* `*.api.ts` contracts (not the
 * stale `src/shared/contracts/contracts.ts` this was originally built
 * against — see `.superpowers/sdd/connect-FINAL-review.md` C2-C6/I5-I8):
 * `reasonCode` (was `reason`), the `member|post|reply|venue|message|community`
 * subject vocabulary (was `user|profile|community_post|forum_post|message|
 * gathering|article`), the `open|resolved|escalated` status vocabulary (was
 * `open|triaged|actioned|dismissed|appealed`), plus the new
 * `anonymous`/`contact_email`/`evidence`/`severity`/`sla_due_at` report
 * columns and `argument`/`action_id`/`appellant_id`/`severity`/`community`
 * appeal columns, and `reason_code`/`duration` audit-log columns.
 *
 * NOT run as part of this task — the orchestrator sequences + runs it
 * against `_test`/dev DBs after wiring `ReportsModule`/`ModerationModule`
 * into `app.module.ts`.
 */
export class AddReportsModeration1782800020000 implements MigrationInterface {
  name = 'AddReportsModeration1782800020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "reports_subject_type_enum" AS ENUM('member', 'post', 'reply', 'venue', 'message', 'community')`,
    );
    await queryRunner.query(
      `CREATE TYPE "reports_status_enum" AS ENUM('open', 'resolved', 'escalated')`,
    );
    await queryRunner.query(
      `CREATE TYPE "reports_severity_enum" AS ENUM('emergency', 'high', 'medium', 'low')`,
    );
    await queryRunner.query(
      `CREATE TYPE "appeals_status_enum" AS ENUM('awaiting', 'upheld', 'overturned')`,
    );

    await queryRunner.query(`
      CREATE TABLE "reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subject_type" "reports_subject_type_enum" NOT NULL,
        "subject_id" character varying NOT NULL,
        "reason_code" character varying NOT NULL,
        "detail" text,
        "anonymous" boolean NOT NULL DEFAULT false,
        "contact_email" character varying,
        "evidence" jsonb,
        "severity" "reports_severity_enum" NOT NULL,
        "sla_due_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" "reports_status_enum" NOT NULL DEFAULT 'open',
        "reporter_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_subject" ON "reports" ("subject_type", "subject_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_status" ON "reports" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_severity" ON "reports" ("severity")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_reporter_id" ON "reports" ("reporter_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "reports" ADD CONSTRAINT "FK_reports_reporter_id"
        FOREIGN KEY ("reporter_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "appeals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "report_id" uuid,
        "action_id" uuid,
        "appellant_id" uuid,
        "severity" "reports_severity_enum" NOT NULL DEFAULT 'medium',
        "community" character varying,
        "argument" text NOT NULL,
        "status" "appeals_status_enum" NOT NULL DEFAULT 'awaiting',
        "decision" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_appeals" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_report_id" ON "appeals" ("report_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_action_id" ON "appeals" ("action_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_appellant_id" ON "appeals" ("appellant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_appeals_status" ON "appeals" ("status")`,
    );
    // `ON DELETE SET NULL`: deleting the underlying report un-links the
    // appeal (which can still stand alone per its nullable `report_id`)
    // rather than cascading the delete into it — mirrors
    // `AddPartners1782693600000`'s `volunteer_opportunities.partner_id` FK.
    await queryRunner.query(`
      ALTER TABLE "appeals" ADD CONSTRAINT "FK_appeals_report_id"
        FOREIGN KEY ("report_id") REFERENCES "reports"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "appeals" ADD CONSTRAINT "FK_appeals_appellant_id"
        FOREIGN KEY ("appellant_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "mod_audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "report_id" uuid NOT NULL,
        "actor_id" uuid NOT NULL,
        "action" character varying NOT NULL,
        "reason_code" character varying,
        "note" text,
        "duration" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mod_audit_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_mod_audit_logs_report_id" ON "mod_audit_logs" ("report_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mod_audit_logs_actor_id" ON "mod_audit_logs" ("actor_id")`,
    );
    // The audit trail is immutable history: a deleted report takes its log
    // rows with it (unlike `appeals`, which can stand without one).
    await queryRunner.query(`
      ALTER TABLE "mod_audit_logs" ADD CONSTRAINT "FK_mod_audit_logs_report_id"
        FOREIGN KEY ("report_id") REFERENCES "reports"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "mod_audit_logs" ADD CONSTRAINT "FK_mod_audit_logs_actor_id"
        FOREIGN KEY ("actor_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Deferred until `mod_audit_logs` exists: the appeal's `action_id` points
    // at the specific action row (`../moderation/entities/appeal.entity.ts`)
    // being appealed.
    await queryRunner.query(`
      ALTER TABLE "appeals" ADD CONSTRAINT "FK_appeals_action_id"
        FOREIGN KEY ("action_id") REFERENCES "mod_audit_logs"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "appeals" DROP CONSTRAINT "FK_appeals_action_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP CONSTRAINT "FK_mod_audit_logs_actor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP CONSTRAINT "FK_mod_audit_logs_report_id"`,
    );
    await queryRunner.query(`DROP TABLE "mod_audit_logs"`);

    await queryRunner.query(
      `ALTER TABLE "appeals" DROP CONSTRAINT "FK_appeals_appellant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "appeals" DROP CONSTRAINT "FK_appeals_report_id"`,
    );
    await queryRunner.query(`DROP TABLE "appeals"`);

    await queryRunner.query(
      `ALTER TABLE "reports" DROP CONSTRAINT "FK_reports_reporter_id"`,
    );
    await queryRunner.query(`DROP TABLE "reports"`);

    await queryRunner.query(`DROP TYPE "appeals_status_enum"`);
    await queryRunner.query(`DROP TYPE "reports_severity_enum"`);
    await queryRunner.query(`DROP TYPE "reports_status_enum"`);
    await queryRunner.query(`DROP TYPE "reports_subject_type_enum"`);
  }
}
