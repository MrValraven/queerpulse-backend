import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `messages` is the single highest-write table in the schema (every send is an
 * insert into it), so the idempotency-key unique index below is built
 * `CONCURRENTLY` rather than with a plain `CREATE UNIQUE INDEX`, which would
 * hold a lock blocking every concurrent insert/update for the whole build.
 * Mirrors the exact mechanism documented in
 * `1785000410000-AddMessageReplyTo.ts` and
 * `1785001500000-AddFeedCursorIndexes.ts`.
 */
export class AddMessageClientId1785000700000 implements MigrationInterface {
  name = 'AddMessageClientId1785000700000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so this
  // migration opts out of the per-migration transaction. Only honored under
  // `migrationsTransactionMode: 'each'` (set in data-source.ts) — under the
  // default `all` mode TypeORM rejects this override outright. Re-runnability
  // comes from the deploy preflight dropping invalid indexes, not
  // `IF NOT EXISTS` guards (forbidden here — they hide drift). See
  // 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "client_message_id" uuid`,
    );
    // Idempotency key: a conversation holds at most one message per client id,
    // so the dual HTTP + WS write paths (and any retry from the offline outbox)
    // collapse to a single row instead of duplicating. Partial so NULL client
    // ids — legacy rows and server-originated messages (message-request seeds,
    // cross-domain enquiries) — are exempt from the uniqueness constraint.
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_messages_conversation_client_id" ON "messages" ("conversation_id", "client_message_id") WHERE "client_message_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_messages_conversation_client_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "client_message_id"`,
    );
  }
}
