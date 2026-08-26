import {
  attendanceRetentionCutoff,
  gatheringEndedAt,
  gatheringEndedAtSql,
  isAttendanceCleared,
} from './event-attendance-window';

/**
 * The clock shared by the sweep that ERASES check-in records and the read that
 * stops REPORTING a count for them. If these two ever disagree the platform
 * counts cleared rows as zero arrivals and tells an organiser nobody came, so
 * the boundary is pinned here rather than left to each caller.
 */
describe('event attendance window', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION_DAYS = 30;
  const now = new Date('2026-06-30T12:00:00.000Z');

  describe('gatheringEndedAt', () => {
    it('uses the stated end time when there is one', () => {
      const startAt = new Date('2026-06-01T18:00:00.000Z');
      const endAt = new Date('2026-06-03T02:00:00.000Z');
      expect(gatheringEndedAt({ startAt, endAt })).toEqual(endAt);
    });

    it('falls back to the start when no end was stated', () => {
      const startAt = new Date('2026-06-01T18:00:00.000Z');
      expect(gatheringEndedAt({ startAt, endAt: null })).toEqual(startAt);
    });

    it('measures a multi-day gathering from its LAST day', () => {
      // Otherwise a festival running 1 to 5 June starts its retention clock on
      // the 1st and could be cleared while it is still running.
      const startAt = new Date('2026-06-01T10:00:00.000Z');
      const endAt = new Date('2026-06-05T23:00:00.000Z');
      expect(gatheringEndedAt({ startAt, endAt }).getTime()).toBe(
        endAt.getTime(),
      );
    });
  });

  describe('gatheringEndedAtSql', () => {
    it('is the same rule the TypeScript expresses, for the sweeper predicate', () => {
      expect(gatheringEndedAtSql('event')).toBe(
        'COALESCE(event.end_at, event.start_at)',
      );
    });
  });

  describe('attendanceRetentionCutoff', () => {
    it('is the configured number of days before now', () => {
      expect(attendanceRetentionCutoff(RETENTION_DAYS, now).getTime()).toBe(
        now.getTime() - RETENTION_DAYS * DAY_MS,
      );
    });
  });

  describe('isAttendanceCleared', () => {
    const endedDaysAgo = (days: number) => ({
      startAt: new Date(now.getTime() - days * DAY_MS),
      endAt: null,
    });

    it('is false for a gathering that has not happened yet', () => {
      const future = {
        startAt: new Date(now.getTime() + 7 * DAY_MS),
        endAt: null,
      };
      expect(isAttendanceCleared(future, RETENTION_DAYS, now)).toBe(false);
    });

    it('is false well inside the window', () => {
      expect(isAttendanceCleared(endedDaysAgo(3), RETENTION_DAYS, now)).toBe(
        false,
      );
    });

    it('is true well past the window', () => {
      expect(isAttendanceCleared(endedDaysAgo(90), RETENTION_DAYS, now)).toBe(
        true,
      );
    });

    it('treats the boundary instant itself as NOT yet cleared', () => {
      // Matches the sweeper's `<` exactly. A gathering that ended at precisely
      // the cutoff still has its rows, so it must still report its count; one
      // millisecond earlier does not.
      const exactly = {
        startAt: new Date(now.getTime() - RETENTION_DAYS * DAY_MS),
        endAt: null,
      };
      expect(isAttendanceCleared(exactly, RETENTION_DAYS, now)).toBe(false);

      const oneMsEarlier = {
        startAt: new Date(now.getTime() - RETENTION_DAYS * DAY_MS - 1),
        endAt: null,
      };
      expect(isAttendanceCleared(oneMsEarlier, RETENTION_DAYS, now)).toBe(true);
    });

    it('follows the end time, so a long gathering stays reportable', () => {
      // Started 40 days ago, finished yesterday: past the window on `start_at`,
      // comfortably inside it on `end_at`.
      const longRun = {
        startAt: new Date(now.getTime() - 40 * DAY_MS),
        endAt: new Date(now.getTime() - 1 * DAY_MS),
      };
      expect(isAttendanceCleared(longRun, RETENTION_DAYS, now)).toBe(false);
    });

    it('honours a shorter configured window', () => {
      expect(isAttendanceCleared(endedDaysAgo(10), 30, now)).toBe(false);
      expect(isAttendanceCleared(endedDaysAgo(10), 7, now)).toBe(true);
    });
  });
});
