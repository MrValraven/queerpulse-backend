// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `HousingService.listJoinRequests` (AUDIT item #19): that query
 * left-joins each request to its co-op, optionally filters `coop.slug =
 * :coopSlug`, and orders `request.created_at DESC` under a bounded
 * `DEFAULT_LIST_LIMIT`. The `coop_join_requests` table already indexes
 * `coop_id` and `user_id` (`IDX_coop_join_requests_coop_id` /
 * `IDX_coop_join_requests_user_id`) but NOT `created_at`, so the coop-scoped
 * admin list had to sort every one of a co-op's requests by `created_at` before
 * applying the limit. This composite b-tree on `(coop_id, created_at DESC)`
 * lets the planner serve a single co-op's newest-first page as an ordered index
 * scan.
 *
 * The `coop_join_requests` table carries production traffic, so the index is
 * built `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction
 * block, so the migration opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddCoopJoinRequestsCoopCreatedAtIndex1785903100000 implements MigrationInterface {
  name = 'AddCoopJoinRequestsCoopCreatedAtIndex1785903100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_coop_join_requests_coop_id_created_at" ` +
        `ON "coop_join_requests" ("coop_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_coop_join_requests_coop_id_created_at"`,
    );
  }
}
