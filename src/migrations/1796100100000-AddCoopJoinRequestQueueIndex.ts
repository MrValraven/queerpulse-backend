// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the fourth moderation queue ENG-41 converted from a flat, silently
 * truncated array to a `{ items, total, page, pageSize }` envelope:
 * `HousingService.listJoinRequests` (`GET /admin/housing/join-requests`).
 * Companion to `1796100000000-AddModerationQueueOrderingIndexes`, which did the
 * same for the other three queues.
 *
 * Pagination made this query do TWO things per request that the old one did not:
 * a `COUNT(*)` over the whole filtered set, so `total` can be honest, and an
 * `OFFSET`/`LIMIT` walk in a defined order.
 *
 * What was there before, and why it was not enough. `coop_join_requests`
 * indexed `coop_id`, `(coop_id, created_at DESC)` and `user_id`
 * (`IDX_coop_join_requests_coop_id`,
 * `IDX_coop_join_requests_coop_id_created_at`,
 * `IDX_coop_join_requests_user_id`) and nothing that starts with `status` or
 * `created_at`. The composite already covers the co-op-scoped read, which is the
 * one that had an index because it was the one the AUDIT-item-19 change looked
 * at. The console's DEFAULT read passes no co-op at all: it is platform-wide,
 * it now filters `status` (previously it fetched every status and discarded the
 * decided rows in the browser, which is the bug the finding's sibling queue
 * turned out to share), and it orders `created_at DESC`. With no leading-column
 * match that read is a full scan of the table plus a sort of everything it
 * finds, on every page an admin turns, and the new `COUNT(*)` is a second full
 * scan on top.
 *
 * `(status, created_at DESC)` serves both: an ordered index scan for the
 * pending-only page, and a much narrower count than the heap. NOT partial on
 * `status = 'pending'`, exactly as the `group_join_requests` index in the
 * companion migration is not: `status` is an OPTIONAL filter on this route and
 * omitting it still returns every state, so a pending-only index would leave
 * the unfiltered read as slow as it is today. Leading with `status` also keeps
 * the whole index usable as an ordered scan when the filter is absent, because
 * Postgres can still walk it per status value.
 *
 * The `DESC` matches the query's own direction. Postgres can walk a b-tree
 * backwards, so it is not strictly required, but stating it keeps the index
 * readable next to the query it exists for.
 *
 * The co-op-scoped path deliberately keeps using
 * `IDX_coop_join_requests_coop_id_created_at` with `status` as a residual
 * filter: one co-op's requests are few enough that filtering them after the
 * ordered index scan costs nothing, and a third composite for that path would
 * cost more write amplification than it saves.
 *
 * `coop_join_requests` carries production traffic, so the index is built
 * `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block, so
 * this migration opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddCoopJoinRequestQueueIndex1796100100000 implements MigrationInterface {
  name = 'AddCoopJoinRequestQueueIndex1796100100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_coop_join_requests_status_created_at" ` +
        `ON "coop_join_requests" ("status", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_coop_join_requests_status_created_at"`,
    );
  }
}
