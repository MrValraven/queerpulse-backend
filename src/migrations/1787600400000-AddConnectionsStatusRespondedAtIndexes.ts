import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance finding B10 (`connections.service.ts:508-519`'s `list` 'all'/
 * 'vouched' branches and `:575-594`'s `countVouched`): both query
 * `connections` with `where: [{ requesterId, status: Accepted }, { addresseeId,
 * status: Accepted }]`, and `list` additionally orders the result
 * `respondedAt DESC`. Today `connections` only carries single-column indexes
 * on `requester_id` and `addressee_id` (see the entity's `@Index` decorators),
 * so each `OR`'d branch can use its column index to find the requester/
 * addressee's rows but then has to filter `status` and sort `responded_at`
 * without index help — the same "filter indexed, sort not" gap already fixed
 * for `event_rsvps` in `1785700500000-AddEventRsvpsStatusOrderIndex.ts`.
 *
 * Fix: one composite index per branch, `(requester_id, status, responded_at)`
 * and `(addressee_id, status, responded_at)`, so each `OR` branch is served by
 * a single index walk that already returns rows in `responded_at DESC` order
 * (Postgres can walk a b-tree backwards, so `DESC` needs no extra column or
 * flag). Deliberately 3 columns, not 4, matching the same "past 3 columns is
 * rarely worth it" guidance cited in `1785700500000`.
 *
 * `connections` already carries production traffic (three prior migrations
 * against it: `1782691700000-AddConnections.ts`,
 * `1782693100000-AddConnectionIntroducerAndFlag.ts`,
 * `1782800820000-AddConnectionRequestReason.ts`), so both indexes are built
 * `CREATE INDEX CONCURRENTLY`, never a plain blocking `CREATE INDEX`.
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual); this project's migration runner uses
 * `migrationsTransactionMode: 'each'` (`src/data-source.ts`), so a migration
 * opting out via `transaction = false` runs standalone without needing a
 * separate `--transaction none` invocation.
 *
 * Composite indexes past a single column have no clean `@Index` decorator
 * expression in this codebase's convention (see `1785700500000` and
 * `1785700100000`'s comments) — migration-only here too, no entity change.
 */
export class AddConnectionsStatusRespondedAtIndexes1787600400000
  implements MigrationInterface
{
  name = 'AddConnectionsStatusRespondedAtIndexes1787600400000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // (forbidden here — hides drift). See 1785700500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_connections_requester_status_responded_at" ` +
        `ON "connections" ("requester_id", "status", "responded_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_connections_addressee_status_responded_at" ` +
        `ON "connections" ("addressee_id", "status", "responded_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_connections_addressee_status_responded_at"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_connections_requester_status_responded_at"`,
    );
  }
}
