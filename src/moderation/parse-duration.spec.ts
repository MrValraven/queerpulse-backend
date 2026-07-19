import { BadRequestException } from '@nestjs/common';
import { MAX_SUSPENSION_DAYS, parseDuration } from './parse-duration';

describe('parseDuration', () => {
  const NOW = new Date('2026-07-19T12:00:00.000Z');

  it('parses days', () => {
    expect(parseDuration('7d', NOW).toISOString()).toBe(
      '2026-07-26T12:00:00.000Z',
    );
  });

  it('parses hours', () => {
    expect(parseDuration('24h', NOW).toISOString()).toBe(
      '2026-07-20T12:00:00.000Z',
    );
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration(' 1d ', NOW).toISOString()).toBe(
      '2026-07-20T12:00:00.000Z',
    );
  });

  it('does not mutate the reference date', () => {
    const before = NOW.getTime();
    parseDuration('7d', NOW);
    expect(NOW.getTime()).toBe(before);
  });

  // Each of these must throw rather than default. A duration that silently
  // became `null` would be indistinguishable from a permanent ban.
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a word', 'forever'],
    ['negative', '-1d'],
    ['zero days', '0d'],
    ['zero hours', '0h'],
    ['unknown unit', '7x'],
    ['unit only', 'd'],
    ['no unit', '7'],
    ['fractional', '1.5d'],
    ['unit first', 'd7'],
    ['compound', '1d12h'],
    ['uppercase unit', '7D'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseDuration(input, NOW)).toThrow(BadRequestException);
  });

  it(`rejects durations over ${MAX_SUSPENSION_DAYS} days`, () => {
    expect(() => parseDuration('9999d', NOW)).toThrow(BadRequestException);
  });

  it(`accepts exactly ${MAX_SUSPENSION_DAYS} days`, () => {
    expect(() => parseDuration(`${MAX_SUSPENSION_DAYS}d`, NOW)).not.toThrow();
  });

  it('rejects an hours value that exceeds the day cap', () => {
    expect(() => parseDuration('9000h', NOW)).toThrow(BadRequestException);
  });
});
