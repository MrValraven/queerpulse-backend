import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Self-referential `messages.reply_to_id` — the "replying to" pointer for a
 * DM. `NULL` means a standalone message; a value points at the message this
 * one quotes. The FK is `ON DELETE SET NULL` (a deleted parent must not
 * cascade-delete the replies that quote it — they simply lose the quote).
 *
 * `messages` is the single highest-write table in the schema, so this
 * migration is careful never to take a build- or validation-lock that would
 * block sends:
 *
 * - The FK is added `NOT VALID` (a brief lock that skips scanning the whole
 *   table) and validated in a SEPARATE `VALIDATE CONSTRAINT` step, which takes
 *   only `SHARE UPDATE EXCLUSIVE` and does not block concurrent
 *   inserts/updates ("ALTER TABLE", PostgreSQL manual). A plain
 *   `ADD CONSTRAINT` would instead scan every existing row under a lock that
 *   blocks writes for the scan's duration.
 * - The index is built `CONCURRENTLY`, which likewise does not block writes,
 *   rather than a plain `CREATE INDEX` that holds a lock for the whole build.
 *
 * Both `CREATE INDEX CONCURRENTLY` and the split add/validate rely on this
 * migration running OUTSIDE a transaction (`CONCURRENTLY` cannot run inside a
 * transaction block at all). See the `transaction = false` flag below and
 * `1785001500000-AddFeedCursorIndexes.ts` for the full landmine writeup.
 */
export class AddMessageReplyTo1785000410000 implements MigrationInterface {
  name = 'AddMessageReplyTo1785000410000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so this
  // migration opts out of the per-migration transaction. Only honored under
  // `migrationsTransactionMode: 'each'` (set in data-source.ts) — under the
  // default `all` mode TypeORM rejects this override outright. Running outside
  // a transaction also lets the `NOT VALID` add and the `VALIDATE` commit
  // separately, so validation never rides inside the same lock as the add.
  // Re-runnability comes from the deploy preflight dropping invalid indexes,
  // not `IF NOT EXISTS` guards (forbidden here — they hide drift). See
  // 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" ADD "reply_to_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_reply_to_id" ` +
        `FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ` +
        `ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" VALIDATE CONSTRAINT "FK_messages_reply_to_id"`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_messages_reply_to_id" ON "messages" ("reply_to_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_messages_reply_to_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_reply_to_id"`,
    );
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "reply_to_id"`);
  }
}
