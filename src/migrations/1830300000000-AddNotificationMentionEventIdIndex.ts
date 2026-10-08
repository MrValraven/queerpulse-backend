import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partial expression index for the "already notified" mention lookup,
 * `EventsService.withoutAlreadyNotifiedMentions`. It runs on every publish and
 * every description edit that carries mentions and filters `notifications` by
 * `type = 'mention'`, `payload ->> 'source' = 'event'` and
 * `payload ->> 'eventId'` (equality, or `IN` over the sibling occurrences of a
 * series). Every other index on the table leads with `user_id`, so the lookup
 * scanned the whole table.
 *
 * The index keys on the same `(payload ->> 'eventId')` expression the query
 * writes and covers only mention rows, a small fraction of the table. The
 * series branch reaches the index through a semi-join on the sibling ids. The
 * query binds `type` as a parameter; node-postgres sends it through an unnamed
 * statement, so Postgres plans with the bound value and proves the literal
 * `type = 'mention'` predicate. The `source = 'event'` filter is applied to
 * the few rows the index returns for one event id.
 *
 * `notifications` carries production traffic, so the index is built
 * `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block.
 * `transaction = false` below is honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddNotificationMentionEventIdIndex1830300000000 implements MigrationInterface {
  name = 'AddNotificationMentionEventIdIndex1830300000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_notifications_mention_event_id" ` +
        `ON "notifications" ((payload ->> 'eventId')) ` +
        `WHERE "type" = 'mention'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_notifications_mention_event_id"`,
    );
  }
}
