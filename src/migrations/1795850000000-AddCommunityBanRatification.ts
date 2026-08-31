// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-25. The table that makes a PERMANENT community bar need two people,
 * the way a permanent PLATFORM ban has since TS-12
 * (`1794921000000-AddBanRatification`).
 *
 * A community bar was the one permanent sanction on QueerPulse one person
 * could hand out alone, and it is the removal most members actually meet: one
 * owner or moderator omitted `banDays` on
 * `DELETE /communities/:slug/members/:memberSlug` and the person was out of
 * that room forever, with no second signature anywhere in the system.
 *
 * What changes around this table, and what does not:
 *
 *  - THE REMOVAL IS STILL IMMEDIATE, and so is a bar. Nobody stays in a room
 *    they were just thrown out of while paperwork clears. What waits is only
 *    the permanence: the removal writes a 30-DAY `community_bans` row and opens
 *    a row here, and the bar becomes permanent (`expires_at = NULL`) only when
 *    a second owner, co-owner or moderator signs.
 *  - AN UNSIGNED HOLD SETTLES AT 30 DAYS rather than lapsing to nothing. The
 *    platform hold lapses, because there the interim consequence is a
 *    suspension nobody confirmed. Here the removal itself was always one
 *    moderator's to make, and putting the person back through the door on a
 *    technicality of staffing would be the wrong failure.
 *  - NO SWEEP JOB IS NEEDED for that. The 30-day term is already on the
 *    `community_bans` row from the first second, so a hold nobody ever decides
 *    leaves exactly the right sanction in force. Expiry here is lazy and only
 *    tidies the record.
 *
 * Notes on the shape:
 *
 *  - `UQ_community_ban_ratifications_pending` is a PARTIAL unique index on
 *    `(community_id, target_user_id) WHERE status = 'pending'`. Two moderators
 *    reaching for the remove button at the same instant must not open two races
 *    on the same person. A plain unique index would also forbid a second hold
 *    months after the first was declined, which is wrong.
 *  - `community_id` and `target_user_id` are `ON DELETE CASCADE`, matching
 *    `community_bans`: a deleted community has no bars to enforce, and an
 *    erased account cannot walk back through the door. The immutable trail of
 *    what was DONE lives in `community_governance_log` and `mod_audit_logs`,
 *    both of which outlive erasure by design.
 *  - `requested_by` / `decided_by` are `ON DELETE SET NULL`, the actor-FK
 *    convention this module already follows: a moderator erasing their account
 *    must not take the record of the hold with them. `requested_by` going NULL
 *    is also fail-safe for the self-signature guard, which compares the signer
 *    against it and treats an unknown proposer as "not you".
 *  - `expires_at` is `timestamptz(3)`, matching `ban_ratifications.expires_at`,
 *    so the pending queue is ordered on the same precision the platform queue
 *    is.
 *  - the rule citation is snapshotted here as well as on `community_bans`,
 *    because the bar can be lifted underneath the hold and the second signatory
 *    still has to be able to read what they were asked to sign.
 *
 * No backfill. There are no historical holds: before this table a permanent
 * community bar simply took effect. EVERY BAR ALREADY IN FORCE STAYS EXACTLY
 * AS IT IS, permanent ones included. Retroactively converting them to 30 days
 * pending a signature nobody can now give would un-bar people whose
 * communities decided about them long ago, on a rule that did not exist then.
 */
export class AddCommunityBanRatification1795850000000 implements MigrationInterface {
  name = 'AddCommunityBanRatification1795850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "community_ban_ratifications_status_enum" AS ENUM('pending', 'ratified', 'declined', 'expired', 'withdrawn')`,
    );
    await queryRunner.query(`
      CREATE TABLE "community_ban_ratifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "community_id" uuid NOT NULL,
        "target_user_id" uuid NOT NULL,
        "target_name" character varying,
        "requested_by" uuid,
        "note" text,
        "rule_index" integer,
        "rule_version" integer,
        "rule_text" text,
        "interim_action" character varying NOT NULL,
        "expires_at" timestamptz(3) NOT NULL,
        "status" "community_ban_ratifications_status_enum" NOT NULL DEFAULT 'pending',
        "decided_by" uuid,
        "decided_at" timestamptz(3),
        "decision_note" text,
        "created_at" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_ban_ratifications" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "community_ban_ratifications" ADD CONSTRAINT "FK_community_ban_ratifications_community_id"
        FOREIGN KEY ("community_id") REFERENCES "communities"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_ban_ratifications" ADD CONSTRAINT "FK_community_ban_ratifications_target_user_id"
        FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_ban_ratifications" ADD CONSTRAINT "FK_community_ban_ratifications_requested_by"
        FOREIGN KEY ("requested_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_ban_ratifications" ADD CONSTRAINT "FK_community_ban_ratifications_decided_by"
        FOREIGN KEY ("decided_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // One open hold per member per community. See this migration's doc comment.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_community_ban_ratifications_pending" ON "community_ban_ratifications" ("community_id", "target_user_id") WHERE "status" = 'pending'`,
    );
    // The per-community queue read (`WHERE community_id = $1 AND status = $2`
    // ordered by `expires_at` ascending) and the lazy expiry sweep, which is
    // the same predicate with `expires_at <= now()`.
    await queryRunner.query(
      `CREATE INDEX "IDX_community_ban_ratifications_community_status_expires" ON "community_ban_ratifications" ("community_id", "status", "expires_at" ASC)`,
    );
    // "Is this member waiting on a signature anywhere", which is how a lift and
    // an erasure find the row to withdraw.
    await queryRunner.query(
      `CREATE INDEX "IDX_community_ban_ratifications_target_user_id" ON "community_ban_ratifications" ("target_user_id")`,
    );
    // Attribution reads: everything one moderator has asked for.
    await queryRunner.query(
      `CREATE INDEX "IDX_community_ban_ratifications_requested_by" ON "community_ban_ratifications" ("requested_by")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_ban_ratifications"`);
    await queryRunner.query(
      `DROP TYPE "community_ban_ratifications_status_enum"`,
    );
  }
}
