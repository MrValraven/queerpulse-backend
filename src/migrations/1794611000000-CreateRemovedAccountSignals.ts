import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `removed_account_signals`: the privacy-preserving correlation material left
 * behind by an account that was removed, so the invite review console can flag
 * a possible return for a human to check (product item TS-05).
 *
 * WHAT IS STORED. Four HMAC-SHA256 digests (sign-in email, OAuth subject,
 * intake email, stated name) computed under a server-side pepper that lives in
 * the environment and never in this database, plus three nullable user
 * references for inviter lineage. No raw address, no raw name, no IP address,
 * no device fingerprint, nothing about what anyone did on the platform.
 *
 * FK POSTURE IS THE WHOLE POINT. Every user reference is `ON DELETE SET NULL`,
 * including the removed account itself, so the row OUTLIVES account erasure.
 * A `CASCADE` here would delete the record exactly when it becomes useful,
 * because the case this exists for is "the account is gone and someone new has
 * turned up". Erasure still removes the identifiable part: the link drops and
 * what remains is a one-way digest that identifies nobody on its own.
 * `community_id` is `SET NULL` for the same reason: deleting a community does
 * not unmake the removal that happened inside it.
 *
 * `UQ_removed_account_signals_account_scope` keeps the record singular per
 * (account, removal kind, community) so re-banning refreshes one row rather
 * than stacking duplicates. `community_id` is folded through `COALESCE` because
 * Postgres treats NULLs as distinct in a unique index, which would otherwise
 * let a platform ban be recorded twice. The index is partial on a present
 * `removed_user_id`: once erasure nulls that column the row is history and two
 * erased rows must be allowed to coexist.
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty in this same
 * migration, so every index builds on nothing and the file stays transactional.
 */
export class CreateRemovedAccountSignals1794611000000 implements MigrationInterface {
  name = 'CreateRemovedAccountSignals1794611000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "removed_account_signals_kind_enum"
        AS ENUM ('platform_ban', 'community_ban')
    `);
    await queryRunner.query(`
      CREATE TABLE "removed_account_signals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "removed_user_id" uuid,
        "removal_kind" "removed_account_signals_kind_enum" NOT NULL,
        "community_id" uuid,
        "removed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "sign_in_email_hash" character varying(64),
        "oauth_subject_hash" character varying(64),
        "intake_email_hash" character varying(64),
        "stated_name_hash" character varying(64),
        "inviter_user_id" uuid,
        "reference_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_removed_account_signals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_removed_account_signals_removed_user" FOREIGN KEY ("removed_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_removed_account_signals_inviter_user" FOREIGN KEY ("inviter_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_removed_account_signals_reference_user" FOREIGN KEY ("reference_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_removed_account_signals_community" FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE SET NULL
      )
    `);

    // The four hash lookups are the hot read: one query per review batch does
    // an `IN (...)` against each of them.
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_sign_in_email_hash"
        ON "removed_account_signals" ("sign_in_email_hash")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_oauth_subject_hash"
        ON "removed_account_signals" ("oauth_subject_hash")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_intake_email_hash"
        ON "removed_account_signals" ("intake_email_hash")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_stated_name_hash"
        ON "removed_account_signals" ("stated_name_hash")
    `);

    // Lineage lookups: "did this member invite or vouch for someone who was
    // removed", and "was this member themselves removed".
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_removed_user_id"
        ON "removed_account_signals" ("removed_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_inviter_user_id"
        ON "removed_account_signals" ("inviter_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_reference_user_id"
        ON "removed_account_signals" ("reference_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_removed_account_signals_community_id"
        ON "removed_account_signals" ("community_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_removed_account_signals_account_scope"
        ON "removed_account_signals" (
          "removed_user_id",
          "removal_kind",
          (COALESCE("community_id", '00000000-0000-0000-0000-000000000000'::uuid))
        )
        WHERE "removed_user_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "removed_account_signals"`);
    await queryRunner.query(`DROP TYPE "removed_account_signals_kind_enum"`);
  }
}
