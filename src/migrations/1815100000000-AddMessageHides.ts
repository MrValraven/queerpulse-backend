import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Delete for me" on a single message (PRD-227) — a PRIVATE, per-user join
 * table (`message_hides`), mirroring `message_stars`'s exact shape
 * (see `1785000900000-AddMessagePinsAndStars.ts`) rather than a column on
 * `messages`: a personal "hide" scoped to the caller by construction, so one
 * member hiding a message never touches what the other participant sees and
 * never looks like the existing author-or-staff tombstone
 * (`messages.deleted_at`) to them. UNIQUE(user_id, message_id) makes
 * hide idempotent. Drops with its message via `ON DELETE CASCADE`, exactly
 * like `message_stars`.
 */
export class AddMessageHides1815100000000 implements MigrationInterface {
  name = 'AddMessageHides1815100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "message_hides" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "message_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_hides" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_message_hides" UNIQUE ("user_id", "message_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_message_hides_user_id" ON "message_hides" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_hides_message_id" ON "message_hides" ("message_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_hides" ADD CONSTRAINT "FK_message_hides_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_hides" ADD CONSTRAINT "FK_message_hides_message_id" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message_hides" DROP CONSTRAINT "FK_message_hides_message_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_hides" DROP CONSTRAINT "FK_message_hides_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "message_hides"`);
  }
}
