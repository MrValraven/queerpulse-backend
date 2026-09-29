import {
  ISSUE_PUBLISH_HOUR,
  isLiveInstant,
  MAGAZINE_TIMEZONE,
  magazineIssueVisibleThroughDate,
  magazineTodayIsoDate,
  resolveIssuePublishInstant,
  zoneOffsetMs,
} from './magazine-clock';

const HOUR_MS = 60 * 60 * 1000;

describe('magazine clock constants', () => {
  it('runs the desk on Lisbon time with a 09:00 issue hour', () => {
    expect(MAGAZINE_TIMEZONE).toBe('Europe/Lisbon');
    expect(ISSUE_PUBLISH_HOUR).toBe(9);
  });
});

describe('zoneOffsetMs', () => {
  it('reads Lisbon as UTC+0 in winter', () => {
    expect(
      zoneOffsetMs(new Date('2026-01-15T12:00:00.000Z'), MAGAZINE_TIMEZONE),
    ).toBe(0);
  });

  it('reads Lisbon as UTC+1 in summer', () => {
    expect(
      zoneOffsetMs(new Date('2026-07-15T12:00:00.000Z'), MAGAZINE_TIMEZONE),
    ).toBe(HOUR_MS);
  });
});

describe('isLiveInstant', () => {
  const now = new Date('2026-09-29T10:00:00.000Z');

  it('treats a null publishedAt as a draft', () => {
    expect(isLiveInstant(null, now)).toBe(false);
  });

  it('treats a past or equal instant as live', () => {
    expect(isLiveInstant(new Date('2026-09-29T09:00:00.000Z'), now)).toBe(true);
    expect(isLiveInstant(new Date(now.getTime()), now)).toBe(true);
  });

  it('treats a future instant as a schedule', () => {
    expect(isLiveInstant(new Date('2026-09-29T10:00:01.000Z'), now)).toBe(
      false,
    );
  });
});

describe('magazineTodayIsoDate', () => {
  it("returns the Lisbon calendar date once Lisbon's midnight has passed", () => {
    // 23:30 UTC in July is 00:30 the next day in Lisbon (UTC+1).
    expect(magazineTodayIsoDate(new Date('2026-07-15T23:30:00.000Z'))).toBe(
      '2026-07-16',
    );
  });

  it('returns the same date as UTC in winter', () => {
    expect(magazineTodayIsoDate(new Date('2026-01-15T23:30:00.000Z'))).toBe(
      '2026-01-15',
    );
  });
});

describe('resolveIssuePublishInstant', () => {
  const shippedAt = new Date('2026-09-29T10:00:00.000Z');

  it('ships an issue dated today at the click', () => {
    expect(resolveIssuePublishInstant('2026-09-29', shippedAt)).toBe(shippedAt);
  });

  it('ships an issue dated in the past at the click', () => {
    expect(resolveIssuePublishInstant('2026-09-01', shippedAt)).toBe(shippedAt);
  });

  it('schedules a future issue for 09:00 Lisbon summer time on its date', () => {
    expect(
      resolveIssuePublishInstant('2026-10-05', shippedAt).toISOString(),
    ).toBe('2026-10-05T08:00:00.000Z');
  });

  it('lands at 09:00 Lisbon on the day summer time starts (2026-03-29)', () => {
    expect(
      resolveIssuePublishInstant(
        '2026-03-29',
        new Date('2026-03-20T10:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-03-29T08:00:00.000Z');
  });

  it('lands at 09:00 Lisbon on the day summer time ends (2026-10-25)', () => {
    expect(
      resolveIssuePublishInstant('2026-10-25', shippedAt).toISOString(),
    ).toBe('2026-10-25T09:00:00.000Z');
  });

  it('falls back to the click for an unparseable date', () => {
    expect(resolveIssuePublishInstant('2099-13-45', shippedAt)).toBe(shippedAt);
  });
});

describe('magazineIssueVisibleThroughDate', () => {
  it('shows only yesterday at 08:59 Lisbon in January (UTC+0)', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2026-01-15T08:59:00.000Z')),
    ).toBe('2026-01-14');
  });

  it('shows today from 09:00 Lisbon in January (UTC+0)', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2026-01-15T09:00:00.000Z')),
    ).toBe('2026-01-15');
  });

  it('shows only yesterday at 08:59 Lisbon in July (UTC+1)', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2026-07-15T07:59:00.000Z')),
    ).toBe('2026-07-14');
  });

  it('shows today from 09:00 Lisbon in July (UTC+1)', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2026-07-15T08:00:00.000Z')),
    ).toBe('2026-07-15');
  });

  it('shows 31 December at 23:30 UTC on 31 December', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2026-12-31T23:30:00.000Z')),
    ).toBe('2026-12-31');
  });

  it('rolls back across the year boundary before 09:00 on 1 January', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2027-01-01T05:00:00.000Z')),
    ).toBe('2026-12-31');
  });

  it('rolls back across a month boundary before 09:00 on the 1st', () => {
    expect(
      magazineIssueVisibleThroughDate(new Date('2026-03-01T08:00:00.000Z')),
    ).toBe('2026-02-28');
  });
});
