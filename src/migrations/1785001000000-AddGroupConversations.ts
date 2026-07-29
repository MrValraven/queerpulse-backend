import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Group conversations — feature #17, PHASE 1 (foundation).
 *
 * Additive only; every existing row keeps DM behaviour:
 *  - `conversations.kind` defaults to `direct`, so all pre-group threads (incl.
 *    the official/welcome thread) stay DMs. `title` / `avatar_url` are NULL for
 *    DMs; `created_by` records a group's creator (FK ON DELETE SET NULL so a
 *    deleted account doesn't cascade the whole thread away).
 *  - `conversation_participants.role` defaults to `member`; a group's creator is
 *    seeded as `owner` by the service. `left_at` records a group departure while
 *    KEEPING the row (history + identity resolution). Phase 2 enforces role
 *    permissions — this phase only adds/seeds the columns.
 *  - `messages.kind` defaults to `user`; a `system` message carries its meaning
 *    in `system_event` (jsonb) — {type, actorId, targetId?, value?} — which the
 *    client renders as a centred pill. `body` stays a plain-text fallback.
 *
 * Enum types follow the repo idiom (see 1785000250000-AddMessageReactions):
 * a named Postgres enum created up-front and dropped in down().
 */
export class AddGroupConversations1785001000000 implements MigrationInterface {
  name = 'AddGroupConversations1785001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- conversations: kind / title / avatar / creator ---
    await queryRunner.query(
      `CREATE TYPE "conversations_kind_enum" AS ENUM('direct', 'group')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "kind" "conversations_kind_enum" NOT NULL DEFAULT 'direct'`,
    );
    await queryRunner.query(`ALTER TABLE "conversations" ADD "title" varchar`);
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "avatar_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "created_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_conversations_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // --- conversation_participants: role / left_at ---
    await queryRunner.query(
      `CREATE TYPE "conversation_participants_role_enum" AS ENUM('owner', 'admin', 'member')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "role" "conversation_participants_role_enum" NOT NULL DEFAULT 'member'`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "left_at" timestamptz`,
    );

    // --- messages: kind / system_event ---
    await queryRunner.query(
      `CREATE TYPE "messages_kind_enum" AS ENUM('user', 'system')`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "kind" "messages_kind_enum" NOT NULL DEFAULT 'user'`,
    );
    await queryRunner.query(`ALTER TABLE "messages" ADD "system_event" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "system_event"`,
    );
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "kind"`);
    await queryRunner.query(`DROP TYPE "messages_kind_enum"`);

    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "left_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "role"`,
    );
    await queryRunner.query(`DROP TYPE "conversation_participants_role_enum"`);

    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_created_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "created_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "avatar_url"`,
    );
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "title"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "kind"`);
    await queryRunner.query(`DROP TYPE "conversations_kind_enum"`);
  }
}
