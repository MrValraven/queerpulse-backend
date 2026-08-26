/**
 * The one definition of "has this gathering's attendance been cleared yet", used
 * by both halves of the retention promise so they cannot disagree.
 *
 * TWO HALVES, ONE RULE. `EventAttendanceRetentionService` ERASES the per-person
 * check-in records 30 days after a gathering ends; `EventsService.rosterCounts`
 * has to STOP REPORTING a check-in count for exactly the same gatherings. When
 * those two disagree the platform states a falsehood as a fact: the sweep nulls
 * `checked_in_at`, and a `COUNT(*) FILTER (WHERE checked_in_at IS NOT NULL)`
 * over the cleared rows returns 0, so an organiser opening a gathering 31 days
 * later reads "0 arrived of 40 going". That is indistinguishable from nobody
 * having turned up, and for an organiser looking back at whether a gathering
 * worked it is a wrong answer with no warning attached.
 *
 * So the count is `null` past the window, meaning "no longer recorded", and the
 * surface renders that instead of a number. Zero keeps its real meaning: nobody
 * arrived.
 *
 * A THIRD USER, AND THE REASON THIS IS A GUARD RATHER THAN A DISPLAY RULE.
 * `EventCheckInService.checkIn` refuses to record an arrival once this returns
 * true. Without that, a host opening a door screen on an old gathering could
 * write a fresh `checked_in_at` onto a row the sweep had already cleared,
 * re-creating the exact personal data the sweep exists to remove, on a
 * gathering the platform has already published a promise to have cleared. It
 * would also leave one arrival recorded against a gathering whose other
 * arrivals are gone, and flip the count back from "no longer recorded" to 1.
 * Unlikely, and cheap to close.
 *
 * The UNDO path is deliberately NOT guarded: clearing a `checked_in_at`
 * removes data rather than creating it, and stays available forever.
 *
 * WHY THE DATE DECIDES, RATHER THAN WHETHER THE SWEEP HAS RUN. Reading the
 * cutoff from the calendar rather than from the state of the rows buys two
 * things. The answer never flickers: it cannot read 18, then 18, then null
 * depending on whether last night's 05:00 cron has fired yet. And it can never
 * report a half-swept number: a backlog larger than one run leaves some rows
 * cleared and some not, and a count over that mixture is a number that was never
 * true. Past the window the honest answer is "not recorded", whether or not the
 * job has caught up.
 */

/**
 * The machine-readable code on the 403 a door check-in gets once the gathering
 * is past its attendance window, so a client can say something true instead of
 * showing a generic failure.
 *
 * Same contract as `INVITE_QUOTA_EXCEEDED` and `AFFIRMING_PLEDGE_REQUIRED`:
 * `code` is what a client branches on, `message` is only a human fallback.
 */
export const EVENT_ATTENDANCE_WINDOW_CLOSED_CODE =
  'EVENT_ATTENDANCE_WINDOW_CLOSED';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a gathering finished, which is the instant every attendance clock runs
 * from.
 *
 * `end_at` when the host stated one, `start_at` otherwise. A multi-day gathering
 * is therefore measured from its last day rather than its first, so its
 * attendance is never cleared while it is still running.
 *
 * `startAt` is `timestamptz NOT NULL` on `events`, so this always has an answer
 * and there is no null-date branch to write.
 */
export function gatheringEndedAt(event: {
  startAt: Date;
  endAt: Date | null;
}): Date {
  return event.endAt ?? event.startAt;
}

/**
 * The SQL for {@link gatheringEndedAt}, so the sweeper's predicate and the
 * TypeScript above are visibly one rule expressed twice. Takes the alias the
 * caller gave the `events` table.
 */
export function gatheringEndedAtSql(eventAlias: string): string {
  return `COALESCE(${eventAlias}.end_at, ${eventAlias}.start_at)`;
}

/**
 * Gatherings that ended before this instant have had their attendance detail
 * cleared, or are due to be on the next sweep.
 *
 * `retentionDays` comes from `retention.eventAttendanceDays` at both call sites
 * (see `src/config/retention.config.ts`) so the erasure window and the reporting
 * window are the same number by construction.
 */
export function attendanceRetentionCutoff(
  retentionDays: number,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/**
 * Whether this gathering's per-person check-in records are gone, so a check-in
 * count can no longer be stated.
 *
 * The boundary matches the sweeper's `<` exactly: a gathering that ended at
 * precisely the cutoff is NOT yet cleared, and is still reported.
 */
export function isAttendanceCleared(
  event: { startAt: Date; endAt: Date | null },
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  return (
    gatheringEndedAt(event).getTime() <
    attendanceRetentionCutoff(retentionDays, now).getTime()
  );
}
