import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Forward / Pin / Star (feature #18), DMs.
 *
 * Storage choices (see also the entities):
 *  - **Pins are a SHARED, per-conversation JOIN TABLE** (`conversation_pinned_messages`),
 *    not `pinned_at`/`pinned_by` columns on `messages`. A pin is a relationship
 *    ("this message is pinned in this conversation, by X, at T") that either
 *    participant sets and both see — and the row already carries
 *    `conversation_id`, so the model generalises to group threads later (a group
 *    can cap pins, or scope who may pin, without a schema change) and keeps a
 *    clean audit of the pinner. UNIQUE(conversation_id, message_id) makes
 *    pin/unpin idempotent.
 *  - **Stars are a PRIVATE, per-user JOIN TABLE** (`message_stars`) — a personal
 *    bookmark scoped to the caller by construction: every read filters on
 *    `user_id`, so one member's stars are never visible to the other.
 *    UNIQUE(user_id, message_id) makes star/unstar idempotent.
 *  - **Forwarded** is a single boolean on `messages`: a forward goes through the
 *    normal idempotent send path and lands as an ordinary new message, tagged
 *    only so the recipient's bubble can render a subtle "Forwarded" label.
 *
 * All three drop with their message via `ON DELETE CASCADE`.
 */
export class AddMessagePinsAndStars1785000900000 implements MigrationInterface {
  name = 'AddMessagePinsAndStars1785000900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Shared, per-conversation pins ---
    await queryRunner.query(`
      CREATE TABLE "conversation_pinned_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "message_id" uuid NOT NULL,
        "pinned_by" uuid NOT NULL,
        "pinned_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_pinned_messages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversation_pinned_messages" UNIQUE ("conversation_id", "message_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_pinned_messages_conversation_id" ON "conversation_pinned_messages" ("conversation_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_pinned_messages_message_id" ON "conversation_pinned_messages" ("message_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" ADD CONSTRAINT "FK_conversation_pinned_messages_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" ADD CONSTRAINT "FK_conversation_pinned_messages_message_id" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" ADD CONSTRAINT "FK_conversation_pinned_messages_pinned_by" FOREIGN KEY ("pinned_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- Private, per-user stars ---
    await queryRunner.query(`
      CREATE TABLE "message_stars" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "message_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_stars" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_message_stars" UNIQUE ("user_id", "message_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_message_stars_user_id" ON "message_stars" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_stars_message_id" ON "message_stars" ("message_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_stars" ADD CONSTRAINT "FK_message_stars_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_stars" ADD CONSTRAINT "FK_message_stars_message_id" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // --- Forwarded flag on the message itself ---
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "forwarded" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "forwarded"`);

    await queryRunner.query(
      `ALTER TABLE "message_stars" DROP CONSTRAINT "FK_message_stars_message_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_stars" DROP CONSTRAINT "FK_message_stars_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "message_stars"`);

    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" DROP CONSTRAINT "FK_conversation_pinned_messages_pinned_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" DROP CONSTRAINT "FK_conversation_pinned_messages_message_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" DROP CONSTRAINT "FK_conversation_pinned_messages_conversation_id"`,
    );
    await queryRunner.query(`DROP TABLE "conversation_pinned_messages"`);
  }
}
