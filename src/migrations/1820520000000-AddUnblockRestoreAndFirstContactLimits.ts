// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-363 (unblock restores what the block took away) and PRD-365
 * (first-contact volume caps).
 *
 * PRD-363, three additive nullable columns with no backfill. Every existing
 * row starts NULL, which reads as "nothing to restore" and keeps today's
 * unblock behaviour (the pair returns to `declined`) for blocks placed before
 * this migration:
 *
 *  - `connections.status_before_block`: the status a block overwrote, kept
 *    only when it was `accepted` or `pending`. Reuses the existing
 *    `connections_status_enum` type (created in `AddConnections1782691700000`).
 *    The requester direction needs no column of its own: nothing can flip
 *    `requester_id` while the row reads `blocked` (`requestConnection` refuses
 *    a blocked pair before its re-open branch).
 *  - `connections.responded_at_before_block`: the `responded_at` a block
 *    overwrote, so a restored `accepted` keeps its original acceptance time
 *    (read by `acceptedSinceByCounterpart`) and a restored `pending` goes back
 *    to NULL.
 *  - `conversations.opened_at_before_block`: the PRD-340 `opened_at` a block
 *    voids, put back once no block remains between the pair.
 *
 * PRD-365, one new append-only table:
 *
 *  - `connection_request_events`: one row per connection request a member
 *    creates (fresh or re-opened), read as a rolling 24 hour count by
 *    `ConnectionsService`. A ledger instead of a count over `connections`
 *    because a request row can be withdrawn (DELETE) or re-opened (keeping
 *    its original `created_at`), and either would let a member walk straight
 *    past a daily cap computed from `connections` alone. Each insert prunes
 *    that member's own rows older than 24 hours, so the table stays at most
 *    one day of requests per member. `ON DELETE CASCADE` on the member, since
 *    the rows carry nothing once the account is gone.
 *
 * The open-pending cap reads `connections (requester_id, status)`, already
 * served by `IDX_connections_requester_status_responded_at`
 * (`AddConnectionsStatusRespondedAtIndexes1787600400000`), so no new index is
 * added for it. The report-driven pause reads `reports` through the existing
 * `IDX_reports_subject` and `(subject_type, created_at DESC)` indexes.
 *
 * All statements are plain `ADD COLUMN` / `CREATE TABLE` / an index on a
 * brand-new empty table, so none needs a `CONCURRENTLY` split.
 */
export class AddUnblockRestoreAndFirstContactLimits1820520000000 implements MigrationInterface {
  name = 'AddUnblockRestoreAndFirstContactLimits1820520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "connections"
        ADD COLUMN "status_before_block" "connections_status_enum" NULL,
        ADD COLUMN "responded_at_before_block" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD COLUMN "opened_at_before_block" timestamptz NULL
    `);
    await queryRunner.query(`
      CREATE TABLE "connection_request_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "requester_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_connection_request_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_connection_request_events_requester_id"
          FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_connection_request_events_requester_created" ` +
        `ON "connection_request_events" ("requester_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_connection_request_events_requester_created"`,
    );
    await queryRunner.query(`DROP TABLE "connection_request_events"`);
    await queryRunner.query(`
      ALTER TABLE "conversations"
        DROP COLUMN "opened_at_before_block"
    `);
    await queryRunner.query(`
      ALTER TABLE "connections"
        DROP COLUMN "responded_at_before_block",
        DROP COLUMN "status_before_block"
    `);
  }
}
