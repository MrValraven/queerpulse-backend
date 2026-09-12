// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The one load-bearing index the profile Now card needs on `connections`,
 * split out from `1817130000000-AddProfileNowHistory.ts` into its own
 * migration for exactly one reason: it must be built `CONCURRENTLY`, and
 * `CONCURRENTLY` cannot share a transaction with anything else.
 *
 * NOT earned by `NowInsightsService.getForOwner`. That query's WHERE is
 * `addressee_id` alone; its 90-day window lives inside two `COUNT(*) FILTER
 * (WHERE created_at >= ...)` expressions, which run over whatever rows the
 * WHERE already produced rather than narrowing them, so there is nothing
 * there for a `(addressee_id, created_at)` composite to range-scan.
 * `IDX_connections_addressee_id` alone serves that query equally.
 *
 * Earned instead by `NowInsightsService.getRespondsWithin`, whose WHERE
 * really is `addressee_id` plus `created_at >= :since` (alongside a
 * `responded_at IS NOT NULL` predicate on a column this index does not
 * cover). No existing index serves that:
 * `IDX_connections_addressee_status_responded_at` puts `status` in second
 * position, which a `created_at` predicate cannot use. This composite lets
 * that scan be a genuine range scan instead of a full filter over a member's
 * whole inbound history. `request_reason` is deliberately NOT in the index:
 * it is a group key on the other query, not a predicate on either one, and
 * the windowed set per member is small.
 *
 * `connections` already carries production traffic (see
 * `1787600400000-AddConnectionsStatusRespondedAtIndexes.ts`), so this index
 * is built `CREATE INDEX CONCURRENTLY`, never a plain blocking `CREATE
 * INDEX`. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual), so this migration opts out via
 * `transaction = false` (honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`), matching
 * `1787600400000-AddConnectionsStatusRespondedAtIndexes.ts`.
 *
 * KEEPING THIS SEPARATE FROM `1817130000000` MATTERS BEYOND STYLE. That
 * migration's column/table/index/FK are ordinary transactional DDL; this
 * index build can be interrupted mid-flight (leaving an INVALID index
 * Postgres cleans up on retry) without touching anything committed by the
 * other file. Mixing the two in one non-transactional migration would put
 * an interruptible concurrent build in the same all-or-nothing unit as
 * brand-new committed objects with no ledger row protecting them, which is
 * the ledger-mismatch failure mode CLAUDE.md warns against. Re-runnability
 * comes from the deploy preflight dropping invalid indexes, not from an
 * `IF NOT EXISTS` guard (forbidden here, since it hides drift; see
 * CLAUDE.md).
 */
export class AddConnectionsAddresseeCreatedIndex1817140000000
  implements MigrationInterface
{
  name = 'AddConnectionsAddresseeCreatedIndex1817140000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability
  // comes from the deploy preflight dropping invalid indexes, not
  // `IF NOT EXISTS` (forbidden here, since it hides drift). See
  // 1787600400000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_connections_addressee_created" ` +
        `ON "connections" ("addressee_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_connections_addressee_created"`,
    );
  }
}
