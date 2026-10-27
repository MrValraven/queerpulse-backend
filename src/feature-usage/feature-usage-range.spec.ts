import { BadRequestException } from '@nestjs/common';
import {
  describeUsageRange,
  FEATURE_USAGE_RANGE_ERROR_CODES,
  FeatureUsageRangeErrorCode,
  listUtcDays,
  resolveUsageRange,
  startOfUtcDay,
  toDateOnlyString,
  UsageRangeQuery,
} from './feature-usage-range';

const NOW = new Date('2026-10-26T15:00:00Z');
const RETENTION_DAYS = 730;

function resolve(query: UsageRangeQuery) {
  return resolveUsageRange(query, NOW, RETENTION_DAYS);
}

function captureRangeError(query: UsageRangeQuery): BadRequestException {
  try {
    resolve(query);
  } catch (error) {
    if (error instanceof BadRequestException) return error;
    throw error;
  }
  throw new Error(
    `Expected resolveUsageRange to reject ${JSON.stringify(query)} with a BadRequestException`,
  );
}

function expectRangeError(
  query: UsageRangeQuery,
  code: FeatureUsageRangeErrorCode,
  messageFragment: string,
): void {
  const error = captureRangeError(query);
  expect(error.getStatus()).toBe(400);
  const body = error.getResponse() as Record<string, unknown>;
  expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request', code });
  expect(body.message).toEqual(expect.stringContaining(messageFragment));
}

describe('resolveUsageRange: presets', () => {
  it('resolves the worked example: 30 days ending yesterday, with the 30 days before it', () => {
    const range = resolve({ rangeDays: '30' });

    expect(range.rangeDays).toBe(30);
    expect(range.rangeStart.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(range.rangeEnd.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(range.previousRangeStart.toISOString()).toBe(
      '2026-08-27T00:00:00.000Z',
    );
    expect(describeUsageRange(range)).toEqual({
      rangeStart: '2026-09-26',
      rangeEnd: '2026-10-25',
      previousRangeStart: '2026-08-27',
      previousRangeEnd: '2026-09-25',
      retentionStart: '2024-10-26',
      isPreviousRangePartial: false,
    });
  });

  it('defaults to 30 days when the request names no range', () => {
    expect(describeUsageRange(resolve({}))).toEqual(
      describeUsageRange(resolve({ rangeDays: '30' })),
    );
    expect(resolve({}).rangeDays).toBe(30);
  });

  it('clamps rangeDays into 1 to 365 days', () => {
    expect(resolve({ rangeDays: '0' }).rangeDays).toBe(1);
    expect(resolve({ rangeDays: '-5' }).rangeDays).toBe(1);
    expect(resolve({ rangeDays: '100000' }).rangeDays).toBe(365);
    expect(resolve({ rangeDays: '365' }).rangeDays).toBe(365);
  });

  it('anchors to the start of the UTC day whatever the hour of the request', () => {
    const lateRange = resolveUsageRange(
      { rangeDays: '7' },
      new Date('2026-10-26T23:59:59Z'),
      RETENTION_DAYS,
    );
    const earlyRange = resolveUsageRange(
      { rangeDays: '7' },
      new Date('2026-10-26T00:00:01Z'),
      RETENTION_DAYS,
    );
    expect(describeUsageRange(lateRange)).toEqual(
      describeUsageRange(earlyRange),
    );
  });
});

describe('resolveUsageRange: custom ranges', () => {
  it('resolves a 10-day custom range with an exclusive end and an equal previous window', () => {
    const range = resolve({ from: '2026-10-01', to: '2026-10-10' });

    expect(range.rangeDays).toBe(10);
    expect(range.rangeStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(range.rangeEnd.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(describeUsageRange(range)).toEqual({
      rangeStart: '2026-10-01',
      rangeEnd: '2026-10-10',
      previousRangeStart: '2026-09-21',
      previousRangeEnd: '2026-09-30',
      retentionStart: '2024-10-26',
      isPreviousRangePartial: false,
    });
  });

  it('accepts a single day ending yesterday', () => {
    const range = resolve({ from: '2026-10-25', to: '2026-10-25' });
    expect(range.rangeDays).toBe(1);
    expect(describeUsageRange(range).rangeEnd).toBe('2026-10-25');
  });

  it('accepts exactly 365 days inclusive', () => {
    expect(resolve({ from: '2025-10-02', to: '2026-10-01' }).rangeDays).toBe(
      365,
    );
  });

  it('flags the previous window as partial when it starts before retention', () => {
    const range = resolve({ from: '2024-10-26', to: '2024-11-04' });
    const described = describeUsageRange(range);
    expect(described.previousRangeStart).toBe('2024-10-16');
    expect(described.isPreviousRangePartial).toBe(true);
  });
});

describe('resolveUsageRange: rejections', () => {
  it('rejects rangeDays sent together with from or to', () => {
    expectRangeError(
      { rangeDays: '30', from: '2026-10-01', to: '2026-10-10' },
      FEATURE_USAGE_RANGE_ERROR_CODES.conflictingParams,
      'rangeDays',
    );
    expectRangeError(
      { rangeDays: '30', from: '2026-10-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.conflictingParams,
      'rangeDays',
    );
  });

  it('rejects a custom range with only one end, naming the missing one', () => {
    expectRangeError(
      { from: '2026-10-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.incomplete,
      'to is missing',
    );
    expectRangeError(
      { to: '2026-10-10' },
      FEATURE_USAGE_RANGE_ERROR_CODES.incomplete,
      'from is missing',
    );
  });

  it('rejects a day that is not a real calendar day', () => {
    expectRangeError(
      { from: '2026-02-30', to: '2026-03-02' },
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDate,
      'from must be a real calendar day',
    );
    expectRangeError(
      { from: '2026-10-01', to: '26-10-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDate,
      'to must be a real calendar day',
    );
    expectRangeError(
      { from: '', to: '2026-10-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDate,
      'YYYY-MM-DD',
    );
  });

  it('rejects a rangeDays that is not a whole number', () => {
    expectRangeError(
      { rangeDays: 'abc' },
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDays,
      'whole number of days from 1 to 365',
    );
    expectRangeError(
      { rangeDays: '7.5' },
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDays,
      'whole number',
    );
    expectRangeError(
      { rangeDays: '' },
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDays,
      'whole number',
    );
  });

  it('rejects a start day after the end day', () => {
    expectRangeError(
      { from: '2026-10-10', to: '2026-10-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.reversed,
      'from (2026-10-10) falls after to (2026-10-01)',
    );
  });

  it('rejects a custom range longer than 365 days inclusive', () => {
    expectRangeError(
      { from: '2025-10-01', to: '2026-10-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.tooLong,
      'at most 365 days',
    );
  });

  it('rejects a start day older than the retention window', () => {
    expectRangeError(
      { from: '2024-10-25', to: '2024-11-01' },
      FEATURE_USAGE_RANGE_ERROR_CODES.beforeRetention,
      'kept for 730 days, so from has to be 2024-10-26 or later',
    );
  });

  it('rejects an end day of today or later', () => {
    expectRangeError(
      { from: '2026-10-20', to: '2026-10-26' },
      FEATURE_USAGE_RANGE_ERROR_CODES.includesToday,
      'to has to be 2026-10-25 or earlier',
    );
    expectRangeError(
      { from: '2026-10-20', to: '2026-10-30' },
      FEATURE_USAGE_RANGE_ERROR_CODES.includesToday,
      'still being counted',
    );
  });
});

describe('FEATURE_USAGE_RANGE_ERROR_CODES', () => {
  it('keeps the wire codes the frontend maps to copy', () => {
    expect(Object.values(FEATURE_USAGE_RANGE_ERROR_CODES).sort()).toEqual([
      'feature_usage_range_before_retention',
      'feature_usage_range_conflicting_params',
      'feature_usage_range_includes_today',
      'feature_usage_range_incomplete',
      'feature_usage_range_invalid_date',
      'feature_usage_range_invalid_days',
      'feature_usage_range_reversed',
      'feature_usage_range_too_long',
    ]);
  });
});

describe('listUtcDays', () => {
  it('lists consecutive UTC days oldest first, across a month boundary', () => {
    expect(listUtcDays(new Date('2026-09-29T00:00:00Z'), 4)).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('returns an empty list for a count of zero', () => {
    expect(listUtcDays(new Date('2026-09-29T00:00:00Z'), 0)).toEqual([]);
  });
});

describe('startOfUtcDay and toDateOnlyString', () => {
  it('truncates an instant to midnight UTC and prints its day', () => {
    const midnight = startOfUtcDay(new Date('2026-10-26T15:42:10Z'));
    expect(midnight.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(toDateOnlyString(midnight)).toBe('2026-10-26');
  });
});
