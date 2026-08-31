// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `connection_declines`, the durable record behind the connection
 * re-request cooldown and cap (PRD-20).
 *
 * WHY. Declining a connection request used to stop nothing. The declined pair
 * row was re-opened as a fresh `pending` request carrying a brand-new
 * free-text `request_message`, immediately and as often as the requester
 * liked. The note field was therefore a member-to-member text channel that
 * survived refusal, and the only durable answer available to the person being
 * contacted was Block, which they have no reason to think they need the first
 * time someone asks politely.
 *
 * SHAPE. One row per ORDERED pair: `(requester_id, addressee_id)` is the
 * unique key, so "A asked B" and "B asked A" are separate facts. Refusing
 * someone must never cost you the ability to reach out to them, and the
 * one-row-per-unordered-pair `connections` table cannot express that.
 *
 * SEPARATE TABLE, NOT COLUMNS ON `connections`. `ConnectionsService.remove`
 * DELETEs the connection row and either party may call it on a declined pair,
 * so a counter stored there would be erasable by exactly the person it
 * constrains (decline, delete, ask again, repeat). This table is untouched by
 * that path.
 *
 * BACKFILL. Every `connections` row already sitting at `declined` is seeded as
 * a single decline, dated from `responded_at` (falling back to `created_at`
 * for any row missing it). That derives the first cooldown from history the
 * schema already holds, so the guard is live for existing refusals on day one
 * rather than only for future ones. `blocked` rows are not seeded: a block
 * already refuses requests through `BlockFilterService`, and the row does not
 * record which side of it was ever declined.
 *
 * Purely transactional DDL plus one INSERT ... SELECT, no enum changes and no
 * CONCURRENTLY, so it runs inside the migration transaction like any other.
 */
export class AddConnectionDeclineCooldown1795780000000 implements MigrationInterface {
  name = 'AddConnectionDeclineCooldown1795780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "connection_declines" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "requester_id" uuid NOT NULL,
        "addressee_id" uuid NOT NULL,
        "decline_count" integer NOT NULL DEFAULT 1,
        "last_declined_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_connection_declines" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_connection_declines_pair" UNIQUE ("requester_id", "addressee_id")
      )
    `);
    // Backs the "have I declined this person" read on the decliner's side.
    await queryRunner.query(
      `CREATE INDEX "IDX_connection_declines_addressee_id" ON "connection_declines" ("addressee_id")`,
    );
    // Backfill from the declines the schema already recorded. `ON CONFLICT DO
    // NOTHING` keeps this safe if the table is somehow not empty.
    await queryRunner.query(`
      INSERT INTO "connection_declines"
        ("requester_id", "addressee_id", "decline_count", "last_declined_at")
      SELECT
        "requester_id",
        "addressee_id",
        1,
        COALESCE("responded_at", "created_at")
      FROM "connections"
      WHERE "status" = 'declined'
      ON CONFLICT ("requester_id", "addressee_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_connection_declines_addressee_id"`,
    );
    await queryRunner.query(`DROP TABLE "connection_declines"`);
  }
}
