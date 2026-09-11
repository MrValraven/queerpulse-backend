import { BadRequestException } from '@nestjs/common';
import {
  assertRsvpsOpen,
  DEFAULT_RSVP_QUESTIONS,
  hasRsvpCutoffPassed,
  mergeRsvpQuestions,
  RSVPS_CLOSED_MESSAGE,
  rsvpClosesAt,
  type RsvpCutoff,
} from './gathering-extras';

const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;

/**
 * The cutoff arithmetic every RSVP write path leans on. Measured on the
 * instant, so "a day before" is exactly 24 hours whatever the gathering's
 * time zone does across a daylight-saving change.
 */
describe('rsvpClosesAt', () => {
  const startAt = new Date('2026-10-25T20:00:00.000Z');

  it('is null when the host set no cutoff', () => {
    expect(rsvpClosesAt(startAt, null)).toBeNull();
  });

  it('closes at the start instant itself for at-start', () => {
    expect(rsvpClosesAt(startAt, 'at-start')?.toISOString()).toBe(
      '2026-10-25T20:00:00.000Z',
    );
  });

  it('closes one hour before the start', () => {
    expect(rsvpClosesAt(startAt, 'one-hour-before')?.toISOString()).toBe(
      '2026-10-25T19:00:00.000Z',
    );
  });

  it('closes exactly 24 hours before the start, across a clock change', () => {
    // Lisbon leaves summer time in the early hours of 25 October 2026, so a
    // wall-clock "same time yesterday" would be 25 hours earlier.
    expect(rsvpClosesAt(startAt, 'day-before')?.toISOString()).toBe(
      '2026-10-24T20:00:00.000Z',
    );
  });

  it('closes 72 hours before the start', () => {
    expect(rsvpClosesAt(startAt, 'three-days-before')?.toISOString()).toBe(
      '2026-10-22T20:00:00.000Z',
    );
  });

  it('reads a value outside the vocabulary as no cutoff', () => {
    expect(
      rsvpClosesAt(startAt, 'a-week-before' as unknown as RsvpCutoff),
    ).toBeNull();
  });
});

describe('hasRsvpCutoffPassed and assertRsvpsOpen', () => {
  const startAt = new Date('2026-10-01T18:00:00.000Z');
  const event = { startAt, rsvpCutoff: 'one-hour-before' as const };
  const closesAt = new Date(startAt.getTime() - HOUR_IN_MILLISECONDS);

  it('stays open until the instant the cutoff arrives', () => {
    const justBefore = new Date(closesAt.getTime() - 1);
    expect(hasRsvpCutoffPassed(event, justBefore)).toBe(false);
    expect(() => assertRsvpsOpen(event, justBefore)).not.toThrow();
  });

  it('is closed at the cutoff instant itself', () => {
    expect(hasRsvpCutoffPassed(event, closesAt)).toBe(true);
  });

  it('refuses with a 400 naming the closed RSVPs', () => {
    const afterCutoff = new Date(closesAt.getTime() + 1);
    expect(() => assertRsvpsOpen(event, afterCutoff)).toThrow(
      BadRequestException,
    );
    expect(() => assertRsvpsOpen(event, afterCutoff)).toThrow(
      RSVPS_CLOSED_MESSAGE,
    );
  });

  it('closes an at-start gathering at its start and leaves it open just before', () => {
    const atStartEvent = { startAt, rsvpCutoff: 'at-start' as const };
    const justBeforeStart = new Date(startAt.getTime() - 1);
    expect(hasRsvpCutoffPassed(atStartEvent, justBeforeStart)).toBe(false);
    expect(hasRsvpCutoffPassed(atStartEvent, startAt)).toBe(true);
    expect(() => assertRsvpsOpen(atStartEvent, startAt)).toThrow(
      RSVPS_CLOSED_MESSAGE,
    );
  });

  it('keeps a gathering with no cutoff open past its start, until it ends', () => {
    const longAfterStart = new Date(
      startAt.getTime() + 10 * HOUR_IN_MILLISECONDS,
    );
    expect(
      hasRsvpCutoffPassed({ startAt, rsvpCutoff: null }, longAfterStart),
    ).toBe(false);
    expect(hasRsvpCutoffPassed({ startAt }, longAfterStart)).toBe(false);
  });
});

describe('mergeRsvpQuestions', () => {
  it('completes a partial map against the all-off default on create', () => {
    expect(
      mergeRsvpQuestions(DEFAULT_RSVP_QUESTIONS, { pronouns: true }),
    ).toEqual({ dietary: false, pronouns: true, access: false });
  });

  it('merges a patch per key over the stored map on update', () => {
    const stored = { dietary: true, pronouns: false, access: true };
    expect(mergeRsvpQuestions(stored, { dietary: false })).toEqual({
      dietary: false,
      pronouns: false,
      access: true,
    });
  });

  it('completes a row loaded without the column', () => {
    expect(mergeRsvpQuestions(undefined)).toEqual({
      dietary: false,
      pronouns: false,
      access: false,
    });
  });
});
