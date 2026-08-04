import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance-track fix (unpaginated event attendees): `EventsService.attendees`
 * (`events.service.ts`) used to run `this.rsvps.find({ where: { eventId } })`
 * with no `LIMIT` at all — every RSVP row for the event (an uncapped,
 * `capacity: null` public gathering can accumulate an unbounded number of
 * `going` rows), post-query filtered and sorted in JS on every dashboard
 * load. It now filters by `(event_id, status)` and pages through
 * `common/pagination.ts`'s `paginate()`, ordered `waitlist_position ASC` (then
 * `created_at ASC`, unindexed here — see the "don't over-index" note below).
 * Today `event_rsvps` only carries `IDX_event_rsvps_event_id` (a single
 * column) — a composite `(event_id, status, waitlist_position)` index lets
 * Postgres serve the status filter AND the primary sort key from one index
 * walk, the same "filter indexed, sort not" fix already applied to
 * `community_posts` in `1785001600000-AddCommunityPostsFeedOrderIndex.ts`.
 *
 * Deliberately 3 columns, not 4: Postgres's own guidance is that composite
 * indexes past 3 columns are rarely worth it ("Multicolumn Indexes",
 * PostgreSQL manual) — `created_at` stays an unindexed tiebreaker, which is
 * fine because within one `(event_id, status)` pair the `going` bucket's
 * `waitlist_position` is uniformly `NULL` (so `created_at` is the only real
 * ordering signal there) while realistic per-event/per-status row counts stay
 * small enough that an in-memory sort over them is cheap.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual); this project's migration runner uses
 * `migrationsTransactionMode: 'each'` (`src/data-source.ts`), so a migration
 * opting out via `transaction = false` runs standalone without needing a
 * separate `--transaction none` invocation.
 */
export class AddEventRsvpsStatusOrderIndex1785700500000 implements MigrationInterface {
  name = 'AddEventRsvpsStatusOrderIndex1785700500000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // (forbidden here — hides drift). See 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_rsvps_status_order" ` +
        `ON "event_rsvps" ("event_id", "status", "waitlist_position")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_event_rsvps_status_order"`,
    );
  }
}
