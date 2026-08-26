import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TS-12. The table that makes Article VIII's "ratified by one additional
 * independent moderator" a thing the software does rather than a thing the
 * constitution says.
 *
 * A `ban` no longer removes an account in one call. It opens a row here, the
 * member is suspended for the length of the hold (`interim_action` records
 * that choice explicitly), and the account action only lands when a SECOND,
 * different moderator ratifies. Nothing about this delays a content takedown:
 * `hide_content`/`remove_content` are separate actions and are untouched.
 *
 * Notes on the shape:
 *
 *  - `UQ_ban_ratifications_pending_target` is a PARTIAL unique index on
 *    `target_user_id WHERE status = 'pending'`. A bulk ban across 100 reports
 *    naming one member has to open ONE hold, and two moderators reaching for
 *    the ban button at the same instant must not open two races on the same
 *    account. A plain unique index would also forbid a second hold years after
 *    the first was declined, which is wrong.
 *  - `target_user_id` is `ON DELETE CASCADE`: a hold on an account that has
 *    been erased is not a record worth keeping, and there is nothing left to
 *    ban. The immutable trail of what was DONE lives in `mod_audit_logs`, which
 *    outlives erasure by design.
 *  - `requested_by` / `decided_by` are `ON DELETE SET NULL`, matching
 *    `mod_audit_logs.actor_id`: a moderator erasing their account must not take
 *    the record of the hold with them. `requested_by` going NULL is also
 *    fail-safe for the self-ratification guard, which compares the ratifier
 *    against it and treats an unknown requester as "not you".
 *  - `report_id` is `ON DELETE SET NULL`, mirroring the same column on
 *    `mod_audit_logs`, and is nullable from the start because the direct admin
 *    path (`POST /admin/members/:id/restrict`) bans without any report.
 *  - `expires_at` is `timestamptz(3)` for the same reason `reports.sla_due_at`
 *    is: the pending queue is ordered by it, and millisecond precision is what
 *    keeps a keyset page over a raw timestamp column correct.
 *
 * No backfill. There are no historical holds: before this table, a ban simply
 * took effect. Bans already in force stay in force and are untouched, which is
 * correct. Retroactively suspending every previously banned member's ban
 * pending a ratification nobody can now give would un-ban them all on expiry.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddBanRatification1794921000000 implements MigrationInterface {
  name = 'AddBanRatification1794921000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "ban_ratifications_status_enum" AS ENUM('pending', 'ratified', 'declined', 'expired', 'withdrawn')`,
    );
    await queryRunner.query(`
      CREATE TABLE "ban_ratifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "report_id" uuid,
        "target_user_id" uuid NOT NULL,
        "target_name" character varying,
        "requested_by" uuid,
        "note" text,
        "reason_code" character varying,
        "interim_action" character varying NOT NULL,
        "expires_at" timestamptz(3) NOT NULL,
        "status" "ban_ratifications_status_enum" NOT NULL DEFAULT 'pending',
        "decided_by" uuid,
        "decided_at" timestamptz(3),
        "decision_note" text,
        "created_at" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ban_ratifications" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "ban_ratifications" ADD CONSTRAINT "FK_ban_ratifications_target_user_id"
        FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "ban_ratifications" ADD CONSTRAINT "FK_ban_ratifications_requested_by"
        FOREIGN KEY ("requested_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "ban_ratifications" ADD CONSTRAINT "FK_ban_ratifications_decided_by"
        FOREIGN KEY ("decided_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "ban_ratifications" ADD CONSTRAINT "FK_ban_ratifications_report_id"
        FOREIGN KEY ("report_id") REFERENCES "reports"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // One open hold per member. See this migration's doc comment.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ban_ratifications_pending_target" ON "ban_ratifications" ("target_user_id") WHERE "status" = 'pending'`,
    );
    // The pending queue: every hold still open, soonest to lapse first. Also
    // the index the lazy expiry sweep reads.
    await queryRunner.query(
      `CREATE INDEX "IDX_ban_ratifications_status_expires_at" ON "ban_ratifications" ("status", "expires_at" ASC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ban_ratifications_status" ON "ban_ratifications" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ban_ratifications_target_user_id" ON "ban_ratifications" ("target_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ban_ratifications_requested_by" ON "ban_ratifications" ("requested_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ban_ratifications_report_id" ON "ban_ratifications" ("report_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ban_ratifications"`);
    await queryRunner.query(`DROP TYPE "ban_ratifications_status_enum"`);
  }
}
