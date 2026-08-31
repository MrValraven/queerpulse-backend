import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LOC-05 — the schema behind the six steps the safe-space page promises.
 *
 * WHAT WAS THERE. `safe_space_nominations` held an intake queue with a status
 * column and nothing that could move it: no acknowledgement, no assignment, no
 * decision, no actor, no reason. The only record of a badge was
 * `listings.safe_space_tier` plus a free-text verifier line a moderator typed,
 * and the flag count the copy promises would suspend a badge lived as a bare
 * integer inside the `listings.safe_space_removal` jsonb, which nothing writes.
 *
 * THREE NEW TABLES AND ELEVEN COLUMNS.
 *
 * 1. `safe_space_nominations` gains the review process. `listing_id` is the
 *    moderator-confirmed link to the business under review, kept separate from
 *    the member-typed `listing_ref` guess. `acknowledged_at` is what stops the
 *    48-hour clock measured from `created_at`. `assigned_*` opens the
 *    nomination for the three independent member visits. `decided_*`,
 *    `awarded_tier` and `reopened_at` are the panel's decision and its undo.
 *    Every actor column is a real FK to `users` ON DELETE SET NULL, so a
 *    moderator erasing their account cannot delete the record of what they
 *    decided.
 *
 * 2. `safe_space_flags` is one row per member flag: author, reason, detail,
 *    timestamp and its own resolution. The existing jsonb `flags: number`
 *    cannot carry any of that, and without a per-flag author "three flags"
 *    cannot be three distinguishable people. The PARTIAL UNIQUE index over
 *    `(listing_id, flagger_id) WHERE withdrawn_at IS NULL AND resolved_at IS
 *    NULL` is what makes a duplicate flag idempotent while still letting a
 *    member raise a fresh one after the last was closed.
 *
 * 3. `safe_space_badge_suspensions` is the temporary suspension the copy
 *    promises. Deliberately NOT a new value on `listings_safe_space_status_enum`
 *    and not a column on `listings`: the badge WAS granted and that grant is
 *    not being rewritten, only paused, and pausing is a moderation fact rather
 *    than a fact about the business (the same reasoning `content_moderation`
 *    documents for keeping takedown state out of the content rows). The PARTIAL
 *    UNIQUE index over `listing_id WHERE lifted_at IS NULL` guarantees a burst
 *    of flags crossing the threshold at once cannot open two suspensions.
 *
 * 4. `safe_space_decision_audits` is the append-only "who, when, why" behind
 *    every act above, keyed polymorphically like `content_moderation`.
 *
 * NO FOREIGN KEY TO `listings` anywhere here, matching every other child of
 * that table in this codebase (`listing_reviews`, `listing_moderation_events`):
 * hard-deleting a listing must never cascade away the safety record of it.
 *
 * TRANSACTIONAL. Every object is created inside this migration's own
 * transaction, so no `CONCURRENTLY` two-phase split is needed.
 */
export class AddSafeSpaceReviewWorkflow1794730000000 implements MigrationInterface {
  name = 'AddSafeSpaceReviewWorkflow1794730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. The nomination review process --------------------------------
    await queryRunner.query(`
      ALTER TABLE "safe_space_nominations"
        ADD COLUMN "listing_id" uuid,
        ADD COLUMN "acknowledged_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "acknowledged_by" uuid,
        ADD COLUMN "assigned_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "assigned_by" uuid,
        ADD COLUMN "assignment_note" text,
        ADD COLUMN "decided_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "decided_by" uuid,
        ADD COLUMN "decision_reason" text,
        ADD COLUMN "awarded_tier" integer,
        ADD COLUMN "reopened_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_nominations_listing_id"
         ON "safe_space_nominations" ("listing_id")`,
    );
    // Sorting the queue by "who has waited longest and has still not been
    // acknowledged" is the query the 48-hour promise turns into.
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_nominations_unacknowledged"
         ON "safe_space_nominations" ("created_at")
         WHERE "acknowledged_at" IS NULL`,
    );
    for (const column of ['acknowledged_by', 'assigned_by', 'decided_by']) {
      await queryRunner.query(`
        ALTER TABLE "safe_space_nominations"
          ADD CONSTRAINT "FK_safe_space_nominations_${column}"
          FOREIGN KEY ("${column}") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      `);
    }

    // --- 2. Member flags --------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "safe_space_flags" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "flagger_id" uuid,
        "reason_code" character varying(40) NOT NULL,
        "detail" text,
        "withdrawn_at" TIMESTAMP WITH TIME ZONE,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by" uuid,
        "resolution" character varying(20),
        "resolution_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_safe_space_flags" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_flags_listing_id"
         ON "safe_space_flags" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_flags_flagger_id"
         ON "safe_space_flags" ("flagger_id")`,
    );
    // "One OPEN flag per member per space" — the idempotency backstop.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_safe_space_flags_open_per_member"
         ON "safe_space_flags" ("listing_id", "flagger_id")
         WHERE "withdrawn_at" IS NULL AND "resolved_at" IS NULL`,
    );
    // The count that decides a suspension, and the moderator queue's default.
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_flags_open"
         ON "safe_space_flags" ("listing_id", "created_at")
         WHERE "withdrawn_at" IS NULL AND "resolved_at" IS NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "safe_space_flags"
        ADD CONSTRAINT "FK_safe_space_flags_flagger_id"
        FOREIGN KEY ("flagger_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "safe_space_flags"
        ADD CONSTRAINT "FK_safe_space_flags_resolved_by"
        FOREIGN KEY ("resolved_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- 3. Temporary badge suspensions -----------------------------------
    await queryRunner.query(`
      CREATE TABLE "safe_space_badge_suspensions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "cause" character varying(20) NOT NULL,
        "flag_count_at_suspension" integer NOT NULL DEFAULT 0,
        "suspended_by" uuid,
        "reason" text,
        "lifted_at" TIMESTAMP WITH TIME ZONE,
        "lifted_by" uuid,
        "lift_reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_safe_space_badge_suspensions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_badge_suspensions_listing_id"
         ON "safe_space_badge_suspensions" ("listing_id")`,
    );
    // At most one OPEN suspension per listing.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_safe_space_badge_suspensions_open"
         ON "safe_space_badge_suspensions" ("listing_id")
         WHERE "lifted_at" IS NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "safe_space_badge_suspensions"
        ADD CONSTRAINT "FK_safe_space_badge_suspensions_suspended_by"
        FOREIGN KEY ("suspended_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "safe_space_badge_suspensions"
        ADD CONSTRAINT "FK_safe_space_badge_suspensions_lifted_by"
        FOREIGN KEY ("lifted_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- 4. The audit trail -----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "safe_space_decision_audits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subject_type" character varying(20) NOT NULL,
        "subject_id" uuid NOT NULL,
        "listing_id" uuid,
        "action" character varying(40) NOT NULL,
        "actor_id" uuid,
        "reason" text,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_safe_space_decision_audits" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_decision_audits_subject"
         ON "safe_space_decision_audits" ("subject_type", "subject_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_decision_audits_listing_id"
         ON "safe_space_decision_audits" ("listing_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_decision_audits_listing_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_decision_audits_subject"`,
    );
    await queryRunner.query(`DROP TABLE "safe_space_decision_audits"`);

    await queryRunner.query(
      `ALTER TABLE "safe_space_badge_suspensions" DROP CONSTRAINT "FK_safe_space_badge_suspensions_lifted_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "safe_space_badge_suspensions" DROP CONSTRAINT "FK_safe_space_badge_suspensions_suspended_by"`,
    );
    await queryRunner.query(
      `DROP INDEX "UQ_safe_space_badge_suspensions_open"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_badge_suspensions_listing_id"`,
    );
    await queryRunner.query(`DROP TABLE "safe_space_badge_suspensions"`);

    await queryRunner.query(
      `ALTER TABLE "safe_space_flags" DROP CONSTRAINT "FK_safe_space_flags_resolved_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "safe_space_flags" DROP CONSTRAINT "FK_safe_space_flags_flagger_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_safe_space_flags_open"`);
    await queryRunner.query(`DROP INDEX "UQ_safe_space_flags_open_per_member"`);
    await queryRunner.query(`DROP INDEX "IDX_safe_space_flags_flagger_id"`);
    await queryRunner.query(`DROP INDEX "IDX_safe_space_flags_listing_id"`);
    await queryRunner.query(`DROP TABLE "safe_space_flags"`);

    for (const column of ['decided_by', 'assigned_by', 'acknowledged_by']) {
      await queryRunner.query(
        `ALTER TABLE "safe_space_nominations" DROP CONSTRAINT "FK_safe_space_nominations_${column}"`,
      );
    }
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_nominations_unacknowledged"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_nominations_listing_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "safe_space_nominations"
        DROP COLUMN "reopened_at",
        DROP COLUMN "awarded_tier",
        DROP COLUMN "decision_reason",
        DROP COLUMN "decided_by",
        DROP COLUMN "decided_at",
        DROP COLUMN "assignment_note",
        DROP COLUMN "assigned_by",
        DROP COLUMN "assigned_at",
        DROP COLUMN "acknowledged_by",
        DROP COLUMN "acknowledged_at",
        DROP COLUMN "listing_id"
    `);
  }
}
