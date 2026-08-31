// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the three moderation queues ENG-41 converted from a flat, silently
 * truncated array to a `{ items, total, page, pageSize }` envelope:
 *
 *  - `CommunitiesService.listJoinRequests`
 *  - `ListingClaimsService.listPending`
 *  - `HousingGroupsService.listJoinRequests`
 *
 * Pagination made each of them do TWO things per request that the old query did
 * not: a `COUNT(*)` over the whole filtered set (so `total` can be honest), and
 * an `OFFSET`/`LIMIT` walk in a defined order. Both want the same index, and
 * none of the three tables had one that could serve either.
 *
 * What was there before, and why it was not enough:
 *
 *  - `community_join_requests` indexed `community_id` alone
 *    (`IDX_community_join_requests_community_id`). The queue filters
 *    `community_id` AND `status = 'pending'` and orders `created_at ASC`, so
 *    every page load had to read all of a community's requests in any status and
 *    sort them. The partial index below covers the filter and provides the sort
 *    order, and because it stores only pending rows it stays small no matter how
 *    much decided history a busy community accumulates: an approved request
 *    leaves the index at the moment it stops being queue work.
 *
 *  - `listing_claims` indexed `status` alone (`IDX_listing_claims_status`),
 *    which answers "which claims are pending" but not "in what order", so the
 *    count was fine and every ordered page was a sort of the whole pending set.
 *    Same partial shape, keyed only on `created_at` because this queue is
 *    platform-wide and takes no other filter.
 *
 *  - `group_join_requests` indexed `group_id` and `user_id` and nothing else.
 *    The console's queue now filters `status` (previously it fetched every
 *    status and discarded the decided ones in the browser, which is the bug) and
 *    orders `created_at DESC`. This one is NOT partial: `status` is an optional
 *    filter on that route and omitting it still returns every state, so a
 *    pending-only index would leave the unfiltered read exactly as slow as it
 *    was. `(status, created_at DESC)` serves the filtered queue as an ordered
 *    index scan and the unfiltered read as an ordered scan of the whole index.
 *    The group-scoped variant keeps using `IDX_group_join_requests_group_id`;
 *    one group's requests are few enough to sort, and a second composite for
 *    that path would cost more to maintain than it saves.
 *
 * The `DESC` on `group_join_requests.created_at` matches the query's own
 * direction. Postgres can walk a b-tree backwards, so it is not strictly
 * required, but stating it keeps the index readable next to the query it exists
 * for.
 *
 * All three tables carry production traffic, so every index is built `CREATE
 * INDEX CONCURRENTLY` — which cannot run inside a transaction block, so this
 * migration opts out (`transaction = false`, honored because `data-source.ts`
 * sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddModerationQueueOrderingIndexes1796100000000 implements MigrationInterface {
  name = 'AddModerationQueueOrderingIndexes1796100000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_join_requests_pending_queue" ` +
        `ON "community_join_requests" ("community_id", "created_at") ` +
        `WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listing_claims_pending_queue" ` +
        `ON "listing_claims" ("created_at") ` +
        `WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_group_join_requests_status_created_at" ` +
        `ON "group_join_requests" ("status", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_group_join_requests_status_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listing_claims_pending_queue"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_community_join_requests_pending_queue"`,
    );
  }
}
