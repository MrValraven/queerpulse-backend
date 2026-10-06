import {
  lisbonCalendarDaysBetween,
  reminderStageFor,
} from './funding-reminder-stage';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('lisbonCalendarDaysBetween', () => {
  it('counts 23:59 UTC as the next Lisbon day in summer time', () => {
    expect(
      lisbonCalendarDaysBetween(
        new Date('2026-10-12T08:00:00.000Z'),
        new Date('2026-10-12T23:59:00.000Z'),
      ),
    ).toBe(1);
  });

  it('counts 23:59 UTC as the same Lisbon day in winter time', () => {
    expect(
      lisbonCalendarDaysBetween(
        new Date('2026-12-01T09:00:00.000Z'),
        new Date('2026-12-01T23:59:00.000Z'),
      ),
    ).toBe(0);
  });

  it('keeps a week a week across the October clock change', () => {
    expect(
      lisbonCalendarDaysBetween(
        new Date('2026-10-22T08:00:00.000Z'),
        new Date('2026-10-29T10:00:00.000Z'),
      ),
    ).toBe(7);
  });
});

describe('reminderStageFor', () => {
  it('sends the one-day reminder on 12 October for a deadline of 23:59 UTC that day', () => {
    expect(
      reminderStageFor(
        new Date('2026-10-12T23:59:00.000Z'),
        new Date('2026-10-12T08:00:00.000Z'),
      ),
    ).toBe('1d');
  });

  it('sends nothing for a call that closes later today in Lisbon', () => {
    expect(
      reminderStageFor(
        new Date('2026-10-12T22:59:00.000Z'),
        new Date('2026-10-12T08:00:00.000Z'),
      ),
    ).toBeNull();
  });

  it('sends the seven-day reminder exactly one Lisbon week ahead', () => {
    expect(
      reminderStageFor(
        new Date('2026-12-08T23:59:00.000Z'),
        new Date('2026-12-01T09:00:00.000Z'),
      ),
    ).toBe('7d');
  });

  it.each([2, 3, 6, 8])('sends nothing %i days ahead', (days) => {
    const now = new Date('2026-12-01T09:00:00.000Z');
    expect(
      reminderStageFor(new Date(now.getTime() + days * DAY_MS), now),
    ).toBeNull();
  });

  it('sends nothing for a deadline that has passed', () => {
    const now = new Date('2026-12-01T09:00:00.000Z');
    expect(reminderStageFor(new Date(now.getTime() - 1), now)).toBeNull();
  });
});
