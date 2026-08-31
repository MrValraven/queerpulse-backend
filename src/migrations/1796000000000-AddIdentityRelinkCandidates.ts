// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `identity_relink_candidates`: the record of a Google identity that presented
 * an existing account's verified email address and was turned away (PRD-06).
 *
 * See the essay on `src/auth/entities/identity-relink-candidate.entity.ts` for
 * why the admin re-link lever is driven by a recorded candidate rather than by
 * an admin typing a Google subject id. In short: a row can only exist if
 * someone finished a Google OAuth round trip carrying `email_verified: true`
 * for the address the account already holds, so the lever can never point an
 * account at an identity that has yet to prove control of that account's own
 * address.
 *
 * ## Shape notes
 *
 *  - `ON DELETE CASCADE` to `users`, deliberately against this repo's usual
 *    actor-FK `SET NULL` convention. Every other nullable user FK exists to
 *    keep a record readable after the person is erased. This row is an
 *    outstanding OFFER to hand an account's identity to a third party, and an
 *    offer must not outlive the account. `decided_by_user_id` follows the
 *    normal convention (`SET NULL`), because that half IS a record.
 *  - `UQ_identity_relink_candidates_user_google` collapses repeated attempts by
 *    the same subject into one row that counts up. The write path is reached
 *    from the unauthenticated OAuth callback, so an insert per attempt would be
 *    an append channel for anyone holding a matching Google account.
 *  - The pending lookup is a PARTIAL index. Decided rows are kept forever as a
 *    trail, and the only read that matters ("what is still waiting on this
 *    member?") never touches them.
 *
 * TRANSACTIONAL, and safely so: a new `CREATE TYPE` rather than an
 * `ALTER TYPE ... ADD VALUE`, and every index builds on a table created empty
 * in the same transaction, so no `CONCURRENTLY` is needed.
 */
export class AddIdentityRelinkCandidates1796000000000 implements MigrationInterface {
  name = 'AddIdentityRelinkCandidates1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "identity_relink_candidate_status_enum" AS ENUM
        ('pending', 'applied', 'dismissed', 'superseded')
    `);
    await queryRunner.query(`
      CREATE TABLE "identity_relink_candidates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "google_id" character varying NOT NULL,
        "status" "identity_relink_candidate_status_enum" NOT NULL DEFAULT 'pending',
        "attempt_count" integer NOT NULL DEFAULT 1,
        "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "decided_by_user_id" uuid,
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "decision_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_identity_relink_candidates" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_identity_relink_candidates_attempt_count_positive"
          CHECK ("attempt_count" >= 1),
        CONSTRAINT "FK_identity_relink_candidates_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_identity_relink_candidates_decided_by"
          FOREIGN KEY ("decided_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identity_relink_candidates_user_google"
        ON "identity_relink_candidates" ("user_id", "google_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_identity_relink_candidates_user_id"
        ON "identity_relink_candidates" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_identity_relink_candidates_pending"
        ON "identity_relink_candidates" ("user_id", "last_seen_at" DESC)
        WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "identity_relink_candidates"`);
    await queryRunner.query(
      `DROP TYPE "identity_relink_candidate_status_enum"`,
    );
  }
}
