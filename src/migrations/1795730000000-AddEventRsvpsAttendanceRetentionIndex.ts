// DO NOT RUN. Authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the nightly sweep in `EventAttendanceRetentionService`, which clears
 * attendance detail on RSVPs for gatherings that ended over the retention
 * window ago (the 30 days the published privacy policy promises).
 *
 * The sweep's batch selector is:
 *
 *   SELECT rsvp.id
 *   FROM event_rsvps rsvp
 *   JOIN events event ON event.id = rsvp.event_id
 *   WHERE COALESCE(event.end_at, event.start_at) < $1
 *     AND (rsvp.checked_in_at IS NOT NULL
 *          OR rsvp.access_needs IS NOT NULL
 *          OR rsvp.dietary_needs IS NOT NULL)
 *   LIMIT $2
 *
 * WHY NONE OF THE FOUR EXISTING INDEXES SERVES IT. `event_rsvps` already
 * carries `IDX_event_rsvps_event_id` (`event_id`), `IDX_event_rsvps_user_id`
 * (`user_id`), `IDX_event_rsvps_status_order`
 * (`event_id, status, waitlist_position`) and the unique `UQ_event_rsvps`
 * (`event_id, user_id`). Every one of them is keyed on columns this predicate
 * does not constrain: the selective half here is "still has something to
 * clear", which none of them expresses. Without this index the planner has
 * nothing to do but read every RSVP ever placed, once a night, forever, on
 * what is the largest table in the schema on any active deployment.
 *
 * WHY PARTIAL, AND WHY IT SHRINKS. The predicate matches only rows that still
 * hold a check-in stamp or free-text access/dietary notes. After the first run
 * drains the backlog, that is the rows from recent gatherings and nothing else,
 * so the index stays small however large the table grows. It is also
 * self-maintaining in the useful direction: the sweep's UPDATE nulls exactly
 * these three columns, which drops each row it touches straight back out of the
 * index.
 *
 * WHY `event_id` IS THE KEY. It is the join column. Handing the planner the
 * join key from inside the partial index turns the sweep into a small index
 * scan feeding a nested loop of primary-key lookups on `events` for the date
 * filter, rather than a scan of either table.
 *
 * WHY NOT AN INDEX ON THE DATE INSTEAD. `COALESCE(end_at, start_at)` is a
 * functional expression, so serving it from `events` would need a functional
 * index on a table that is read on nearly every request, to speed up one cron.
 * The cheap, selective side of this query is the RSVP predicate, so that is
 * where the index goes. `IDX_events_status_start_at` is left exactly as it is.
 *
 * `event_rsvps` carries production traffic, so the index is built
 * `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block. The
 * migration therefore opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`), matching
 * `1795710000000-AddReportsReporterCreatedAtIndex`. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * UNAPPLIED. The maintainer runs `pnpm run migration:run`.
 */
export class AddEventRsvpsAttendanceRetentionIndex1795730000000 implements MigrationInterface {
  name = 'AddEventRsvpsAttendanceRetentionIndex1795730000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_event_rsvps_attendance_retention" ` +
        `ON "event_rsvps" ("event_id") ` +
        `WHERE "checked_in_at" IS NOT NULL ` +
        `OR "access_needs" IS NOT NULL ` +
        `OR "dietary_needs" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_event_rsvps_attendance_retention"`,
    );
  }
}
