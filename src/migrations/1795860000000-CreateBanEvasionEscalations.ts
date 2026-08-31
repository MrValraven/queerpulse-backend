// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ban_evasion_escalations`: a community moderator asking platform staff to
 * check whether a join-request applicant is somebody returning after a ban
 * (PRD-31).
 *
 * WHY THE TABLE EXISTS. Ban-evasion signals were staff-only, so a community
 * moderator triaging a join request from a likely returning banned member saw
 * nothing, even though their own community bans fed the signal store. They now
 * see exactly one bit, "this applicant matches somebody THIS community banned",
 * and no score, tier, hash, prior account or date, and nothing at all from
 * another community or from a platform-level ban. This row is how they hand the
 * wider question to the people who can see the whole picture. The full
 * cross-community assessment already lives on `/admin/ban-evasion`, and an
 * escalation puts the case on that same console rather than opening an inbox of
 * its own.
 *
 * ONE OPEN ESCALATION PER (community, join request), enforced by the partial
 * unique index `UQ_ban_evasion_escalations_open` (`WHERE status = 'open'`), the
 * precedent set by `UQ_reports_open_reporter_subject` and
 * `UQ_community_owner_review_requests_open`. A moderator pressing the button
 * twice, or two moderators of the same community pressing it at once, gets the
 * existing escalation back: the service fast-paths on a `findOne` and this
 * index is what closes the race behind it. Once staff resolve the case the
 * community may escalate again, which is why the index is partial.
 *
 * FK behaviour. `community_id` and `join_request_id` CASCADE: a deleted
 * community or a deleted join request leaves nothing to adjudicate. The three
 * user columns are nullable and `ON DELETE SET NULL`, the actor-FK convention
 * this repo follows (`reports.assigned_moderator_id`,
 * `community_bans.banned_by_user_id`): a moderator leaving the platform must
 * not delete the case they raised, and a resolved case stays readable as
 * history after the applicant erases their account.
 *
 * TRANSACTIONAL, and safely so. The `CREATE TYPE` is a new type rather than an
 * `ALTER TYPE ... ADD VALUE` on an existing one, so the non-transactional rule
 * those files opt out for does not apply. Every index builds on a table created
 * empty in the same transaction, so none of them needs `CONCURRENTLY`.
 */
export class CreateBanEvasionEscalations1795860000000 implements MigrationInterface {
  name = 'CreateBanEvasionEscalations1795860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "ban_evasion_escalations_status_enum" AS ENUM
        ('open', 'resolved')
    `);
    await queryRunner.query(`
      CREATE TABLE "ban_evasion_escalations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "join_request_id" uuid NOT NULL,
        "subject_user_id" uuid,
        "raised_by_user_id" uuid,
        "note" text,
        "status" "ban_evasion_escalations_status_enum" NOT NULL DEFAULT 'open',
        "resolved_by_user_id" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolution_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ban_evasion_escalations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ban_evasion_escalations_community"
          FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ban_evasion_escalations_join_request"
          FOREIGN KEY ("join_request_id")
          REFERENCES "community_join_requests"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ban_evasion_escalations_subject"
          FOREIGN KEY ("subject_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_ban_evasion_escalations_raised_by"
          FOREIGN KEY ("raised_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_ban_evasion_escalations_resolved_by"
          FOREIGN KEY ("resolved_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ban_evasion_escalations_community_id"
        ON "ban_evasion_escalations" ("community_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ban_evasion_escalations_join_request_id"
        ON "ban_evasion_escalations" ("join_request_id")
    `);
    // The staff queue: every escalation at one status, newest first. `id DESC`
    // breaks the tie so a page stays stable when several arrive in the same
    // instant.
    await queryRunner.query(`
      CREATE INDEX "IDX_ban_evasion_escalations_status_created_at"
        ON "ban_evasion_escalations" ("status", "created_at" DESC, "id" DESC)
    `);
    // The rule the whole idempotent-escalation path rests on. See the doc
    // comment above.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ban_evasion_escalations_open"
        ON "ban_evasion_escalations" ("community_id", "join_request_id")
        WHERE "status" = 'open'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ban_evasion_escalations"`);
    await queryRunner.query(`DROP TYPE "ban_evasion_escalations_status_enum"`);
  }
}
