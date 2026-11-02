import {
  eventScheduleProblem,
  MAX_GATHERING_SPAN_DAYS,
} from './event-schedule-rules';

// Pinned so every case reads off one known instant.
const NOW = new Date('2026-11-02T10:00:00.000Z');
const MINUTE_IN_MILLISECONDS = 60_000;
const DAY_IN_MILLISECONDS = 86_400_000;

const later = (start: Date, milliseconds: number) =>
  new Date(start.getTime() + milliseconds);

describe('eventScheduleProblem', () => {
  const tomorrowEvening = new Date('2026-11-03T20:00:00.000Z');

  it('names a start before now when past starts are refused', () => {
    const yesterday = new Date('2026-11-01T20:00:00.000Z');
    expect(
      eventScheduleProblem(yesterday, null, { rejectPast: true, now: NOW }),
    ).toBe('startInPast');
    expect(
      eventScheduleProblem(yesterday, null, { rejectPast: false, now: NOW }),
    ).toBeNull();
  });

  it('names an end equal to the start', () => {
    expect(
      eventScheduleProblem(tomorrowEvening, tomorrowEvening, {
        rejectPast: true,
        now: NOW,
      }),
    ).toBe('endNotAfterStart');
    expect(
      eventScheduleProblem(
        tomorrowEvening,
        later(tomorrowEvening, -MINUTE_IN_MILLISECONDS),
        { rejectPast: true, now: NOW },
      ),
    ).toBe('endNotAfterStart');
  });

  it('accepts exactly fourteen days', () => {
    expect(MAX_GATHERING_SPAN_DAYS).toBe(14);
    expect(
      eventScheduleProblem(
        tomorrowEvening,
        later(tomorrowEvening, 14 * DAY_IN_MILLISECONDS),
        { rejectPast: true, now: NOW },
      ),
    ).toBeNull();
    expect(
      eventScheduleProblem(
        tomorrowEvening,
        later(tomorrowEvening, 14 * DAY_IN_MILLISECONDS + 1),
        { rejectPast: true, now: NOW },
      ),
    ).toBe('spanTooLong');
  });

  it('reports the past start first when both rules fail', () => {
    const yesterday = new Date('2026-11-01T20:00:00.000Z');
    expect(
      eventScheduleProblem(yesterday, yesterday, {
        rejectPast: true,
        now: NOW,
      }),
    ).toBe('startInPast');
  });

  it('accepts an open end', () => {
    expect(
      eventScheduleProblem(tomorrowEvening, null, {
        rejectPast: true,
        now: NOW,
      }),
    ).toBeNull();
  });
});
