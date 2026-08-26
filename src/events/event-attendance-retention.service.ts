import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventRsvp } from './entities/event-rsvp.entity';
import { gatheringEndedAtSql } from './event-attendance-window';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Clears the attendance detail on RSVPs for gatherings that finished long
 * enough ago, honouring the retention period the published privacy policy has
 * always promised ("gathering attendance 30 days after the event") and which
 * nothing enforced. Every other period the policy names had a sweeper behind
 * it; this one was a sentence with no code, which is worse than an undisclosed
 * period because members made decisions against it.
 *
 * ── WHAT "CLEARS" MEANS HERE, AND WHY IT IS NOT A DELETE ────────────────────
 *
 * Deleting the RSVP row was the obvious reading and it is the wrong one. Three
 * things depend on the row surviving:
 *
 *  1. HEADCOUNT. There is no denormalised attendee count anywhere: every number
 *     a host or a past-gathering page shows is aggregated from these rows at
 *     read time (`EventsService.rosterCounts` computes `goingCount`,
 *     `seatsTaken`, `waitlistCount` with `COUNT(*) FILTER (...)`). Deleting
 *     would silently rewrite the history of every gathering ever held to zero
 *     attendees.
 *  2. THE REMOVAL STAMP. `removed_by_host_at` is what stops a member a host
 *     removed from pressing the button again and walking back onto a roster
 *     (see the column's own note on the entity). It is a safety record, and it
 *     outlives the gathering it was set on.
 *  3. THE MEMBER'S OWN HISTORY. "Which gatherings did I go to" is the member's
 *     data working FOR them, it is in their Art. 20 export, and destroying it a
 *     month after every gathering would be hostile to the person the retention
 *     period exists to protect.
 *
 * So this follows `AccountRetentionService.expireOldDataExportArchives`, the
 * sibling with exactly this tension: keep the row, null the payload. What is
 * nulled is the part that is genuinely a record of a person at a place:
 *
 *  - `checked_in_at`: the host's record that this member physically came
 *    through the door of this gathering. This is attendance in the strict
 *    sense, and it is the single most sensitive field on the row: in this
 *    community "attended the trans support meetup on this date" is exactly the
 *    linkage that outs somebody.
 *  - `access_needs`: free text the member wrote about what they need to be
 *    able to attend. Routinely health and disability information (Art. 9).
 *  - `dietary_needs`: free text that regularly discloses religion or a health
 *    condition (Art. 9-adjacent).
 *
 * What is deliberately KEPT: `status`, `guest_count` and `waitlist_position`
 * (the countable fields, so 1 above still works), `removed_by_host_at` (2),
 * `event_id`/`user_id` (3), and `visibility`, which is a stated preference
 * rather than a record of attending.
 *
 * The limit of that, stated plainly rather than glossed: a cleared row still
 * says this member said they were going. The published sentence should be read,
 * and published, as covering the check-in record and the details a member
 * supplied. See `docs/ops/retention-periods.md`.
 *
 * ── THE CLOCK ───────────────────────────────────────────────────────────────
 *
 * The window runs from when the GATHERING ended, never from when the row was
 * created. An RSVP placed in January for a gathering in June must not clear in
 * February. The cutoff is therefore `COALESCE(events.end_at, events.start_at)`,
 * so a multi-day gathering is measured from its last day rather than its first
 * and is never cleared while it is still running.
 *
 * That clock is defined once, in `event-attendance-window.ts`, and used from
 * here in SQL and from `EventsService.rosterCounts` in TypeScript. The two have
 * to agree: this erases the per-person check-in records, and `rosterCounts` has
 * to stop reporting a check-in count for exactly the same gatherings, or the
 * cleared rows are counted as zero arrivals and an organiser is told nobody
 * came. See that module's header for the whole argument.
 *
 * The edge cases, and what each one does:
 *
 *  - NO DATE AT ALL: impossible. `events.start_at` is `timestamptz NOT NULL`,
 *    so every gathering has a start. There is no null-date branch here because
 *    there is no null-date row to branch on.
 *  - NO END TIME: ordinary and common (`end_at` is nullable). `COALESCE` falls
 *    back to `start_at`, so a gathering with no stated end is measured from
 *    when it began.
 *  - MOVED: a host can reschedule, and `start_at`/`end_at` are read fresh on
 *    every tick. A gathering moved into the future stops being eligible and its
 *    details are kept again; one moved into the past becomes eligible. That is
 *    correct rather than merely tolerable: the promise is thirty days after the
 *    gathering, and a gathering the host says has not happened yet has not
 *    happened yet.
 *  - CANCELLED (`status = 'cancelled'`): swept on the same clock, deliberately
 *    NOT excluded. Nobody attended, so there is no attendance worth keeping,
 *    and the access and dietary notes members supplied for a gathering that
 *    never took place are pure liability.
 *  - DRAFT: not special-cased. A draft cannot be RSVP'd to, so it has no rows
 *    to clear; an old draft that somehow carries one is treated like any other.
 *  - DELETED GATHERING: cannot leave anything behind. `FK_event_rsvps_event_id`
 *    is `ON DELETE CASCADE`, so an RSVP never outlives its gathering and there
 *    are no orphans on an unknowable clock.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 *
 * Single-instance job, like every neighbouring cron: the app is single-replica
 * and enforced so at boot (`src/config/env.validation.ts`), so no distributed
 * lock is added here. It would be safe anyway, because the write is
 * condition-based and idempotent: a row already cleared no longer matches the
 * predicate, so an overlapping tick finds nothing left to do.
 *
 * Batched through a primary-key subselect with a `LIMIT`, the same shape
 * `deleteInBatches` and `expireOldDataExportArchives` use, so one statement can
 * never take a long lock on the largest table in the schema. Errors are
 * swallowed and logged: @nestjs/schedule does not wrap handlers, so an escaping
 * rejection becomes an unhandledRejection that can take the process down. The
 * next tick retries whatever this one missed.
 */
@Injectable()
export class EventAttendanceRetentionService {
  private readonly logger = new Logger(EventAttendanceRetentionService.name);

  constructor(
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    private readonly config: ConfigService,
  ) {}

  // 05:00, on its own hour. The daily retention crons deliberately sit one per
  // hour (01:00 notifications, 02:00 push subscriptions, 03:00 data-export
  // archives and card scans, 04:00 the storage orphan sweep's default), and
  // this one joins the largest table in the schema to `events`, so there is no
  // reason for it to contend with another sweep for the same pool on the same
  // tick.
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async clearPastEventAttendance(): Promise<void> {
    try {
      const retentionDays = this.config.get<number>(
        'retention.eventAttendanceDays',
        30,
      );
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(
        Date.now() - retentionDays * MILLISECONDS_PER_DAY,
      );

      let totalCleared = 0;
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
        const result = await this.rsvps
          .createQueryBuilder()
          .update(EventRsvp)
          .set({
            checkedInAt: null,
            accessNeeds: null,
            dietaryNeeds: null,
          })
          // The `HAS_SOMETHING_TO_CLEAR` half of the predicate is what keeps
          // this from rewriting the same rows every night forever: an already
          // cleared row stops matching, so the sweep converges and the logged
          // count means "rows cleared on this run" rather than "rows that are
          // old".
          .where(
            `id IN (
               SELECT rsvp.id
               FROM event_rsvps rsvp
               JOIN events event ON event.id = rsvp.event_id
               WHERE ${gatheringEndedAtSql('event')} < :cutoff
                 AND (
                   rsvp.checked_in_at IS NOT NULL
                   OR rsvp.access_needs IS NOT NULL
                   OR rsvp.dietary_needs IS NOT NULL
                 )
               LIMIT :batchSize
             )`,
            { cutoff, batchSize },
          )
          .execute();
        const cleared = result.affected ?? 0;
        totalCleared += cleared;
        if (cleared < batchSize) {
          break;
        }
      }
      if (totalCleared > 0) {
        this.logger.log(
          `Cleared attendance detail on ${totalCleared} RSVP(s) for gatherings that ended over ${retentionDays} days ago`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Event-attendance retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
