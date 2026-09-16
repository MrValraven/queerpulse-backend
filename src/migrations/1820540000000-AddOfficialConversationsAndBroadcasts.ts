// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-372: official conversations become writable, by Admins only.
 *
 * `conversations.official_member_id` names the ONE member an official thread
 * belongs to. The partial unique index `UQ_conversations_official_member`
 * (WHERE NOT NULL) is what makes "exactly one official thread per member" a
 * database guarantee, so two admins messaging the same member at the same
 * instant (or a broadcast racing a direct message) converge on one row via
 * `INSERT ... ON CONFLICT DO NOTHING` instead of splitting the member's
 * official history across two threads. The CHECK keeps the column
 * meaningful: only an `is_official` row may carry it. FK `ON DELETE CASCADE`,
 * because an official thread with no member left in it has no reader.
 *
 * Existing rows are untouched: nothing ever set `is_official = true` before
 * this migration, so there is no backfill.
 *
 * `official_broadcasts` is the durable record of one "message everyone" run.
 * The row is written BEFORE any delivery, so a restart mid-run resumes from
 * `cursor_user_id` (keyset over `users.id`) once `lease_expires_at` lapses.
 * `attempt_count` bounds how often a run that keeps crashing is retried before
 * it is marked `failed`. `idempotency_key` is UNIQUE so a double-submitted
 * broadcast is one broadcast.
 *
 * `lease_owner` is the token that makes the lease an ownership proof rather
 * than just an expiry. A worker mints one per claim and carries it on every
 * renewal and on the completion, so a run whose batch outlived
 * `lease_expires_at` and was reclaimed elsewhere cannot have its old worker
 * keep writing to it: the stale worker's UPDATE matches no row, and it stops.
 * Without it two workers walked the same broadcast, double-counting
 * `delivered_count` and writing the cursor backwards, which made the run
 * re-walk slices it had already finished.
 *
 * Per-member exactly-once needs no new column: every delivered message is
 * posted with `client_message_id = official_broadcasts.id`, so the existing
 * `UQ_messages_conversation_client_id` unique index on
 * `(conversation_id, client_message_id)` refuses a second copy of the same
 * broadcast in the same member's thread, and a replayed batch reads the
 * stored message back instead of writing another.
 *
 * `mod_audit_logs.action` is a plain varchar column, so the two new
 * audit actions (`official_message_sent`, `official_broadcast_sent`) need no
 * DDL here.
 */
export class AddOfficialConversationsAndBroadcasts1820540000000 implements MigrationInterface {
  name = 'AddOfficialConversationsAndBroadcasts1820540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "official_member_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_official_member_id"
        FOREIGN KEY ("official_member_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "CHK_conversations_official_member_is_official"
        CHECK ("official_member_id" IS NULL OR "is_official" = true)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversations_official_member"
        ON "conversations" ("official_member_id")
        WHERE "official_member_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "official_broadcasts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "body" text NOT NULL,
        "actor_id" uuid,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "recipient_count" integer NOT NULL DEFAULT 0,
        "delivered_count" integer NOT NULL DEFAULT 0,
        "idempotency_key" character varying(128) NOT NULL,
        "cursor_user_id" uuid,
        "lease_expires_at" TIMESTAMP WITH TIME ZONE,
        "lease_owner" uuid,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_official_broadcasts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_official_broadcasts_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_official_broadcasts_status"
          CHECK ("status" IN ('pending', 'sending', 'completed', 'failed')),
        CONSTRAINT "FK_official_broadcasts_actor_id"
          FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    // The history list (`GET /admin/official-messages/broadcasts`, newest 50).
    // Ascending, matching the `@Index` on `OfficialBroadcast.createdAt` exactly
    // so `migration:generate` never proposes dropping and recreating it.
    // Postgres walks a btree backwards at the same cost, so the newest-first
    // ORDER BY is served either way.
    await queryRunner.query(`
      CREATE INDEX "IDX_official_broadcasts_created_at"
        ON "official_broadcasts" ("created_at")
    `);
    // The resume sweep only ever looks at unfinished runs.
    await queryRunner.query(`
      CREATE INDEX "IDX_official_broadcasts_unfinished"
        ON "official_broadcasts" ("created_at")
        WHERE "status" IN ('pending', 'sending')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_official_broadcasts_unfinished"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_official_broadcasts_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "official_broadcasts"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_conversations_official_member"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "CHK_conversations_official_member_is_official"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_official_member_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "official_member_id"`,
    );
  }
}
