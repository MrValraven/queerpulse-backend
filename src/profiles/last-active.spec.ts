import {
  ActivityBand,
  bandFor,
  coarsenToMonth,
  dayKey,
  visibleBand,
} from './last-active';

describe('coarsenToMonth', () => {
  it('pins any instant to the first day of its month', () => {
    expect(coarsenToMonth(new Date('2026-08-25T22:41:07.913Z'))).toBe(
      '2026-08-01',
    );
  });

  it('keeps a first-of-the-month instant on the first', () => {
    expect(coarsenToMonth(new Date('2026-08-01T00:00:00.000Z'))).toBe(
      '2026-08-01',
    );
  });

  it('zero-pads single-digit months', () => {
    expect(coarsenToMonth(new Date('2026-01-31T23:59:59.999Z'))).toBe(
      '2026-01-01',
    );
    expect(coarsenToMonth(new Date('2026-09-09T09:09:09.000Z'))).toBe(
      '2026-09-01',
    );
  });

  it('reads the instant in UTC, so the last second of a month never rolls back a month', () => {
    // 23:30 UTC on the 31st is already the 1st in Lisbon summer time. Reading
    // local time here would store the WRONG month on a server west of UTC and
    // the right one east of it, which is exactly the drift a `date` column
    // cannot disambiguate later.
    expect(coarsenToMonth(new Date('2026-07-31T23:30:00.000Z'))).toBe(
      '2026-07-01',
    );
    expect(coarsenToMonth(new Date('2026-08-01T00:30:00.000Z'))).toBe(
      '2026-08-01',
    );
  });

  it('discards everything finer than the month', () => {
    const morning = coarsenToMonth(new Date('2026-08-02T06:00:00.000Z'));
    const night = coarsenToMonth(new Date('2026-08-27T23:59:00.000Z'));
    // Two sessions 25 days apart are indistinguishable once stored. That is the
    // whole privacy claim of this feature, so it is asserted rather than
    // assumed.
    expect(morning).toBe(night);
  });
});

describe('dayKey', () => {
  it('is the UTC calendar day, zero-padded', () => {
    expect(dayKey(new Date('2026-08-05T00:00:00.000Z'))).toBe('2026-08-05');
    expect(dayKey(new Date('2026-08-05T23:59:59.999Z'))).toBe('2026-08-05');
    expect(dayKey(new Date('2026-08-06T00:00:00.000Z'))).toBe('2026-08-06');
  });

  it('is stable across a month boundary', () => {
    expect(dayKey(new Date('2026-12-31T12:00:00.000Z'))).toBe('2026-12-31');
    expect(dayKey(new Date('2027-01-01T12:00:00.000Z'))).toBe('2027-01-01');
  });
});

describe('bandFor', () => {
  const now = new Date('2026-08-25T12:00:00.000Z');

  it('returns null for a member with nothing recorded', () => {
    // NOT `Dormant`. On the day this ships every existing member is in this
    // state, and calling them inactive on data never collected would be a lie
    // told about the entire directory at once.
    expect(bandFor(null, now)).toBeNull();
    expect(bandFor(undefined, now)).toBeNull();
    expect(bandFor('', now)).toBeNull();
  });

  it('reads the current month as "this month"', () => {
    expect(bandFor('2026-08-01', now)).toBe(ActivityBand.ThisMonth);
  });

  it('reads one, two and three months back as the recent band', () => {
    expect(bandFor('2026-07-01', now)).toBe(ActivityBand.LastThreeMonths);
    expect(bandFor('2026-06-01', now)).toBe(ActivityBand.LastThreeMonths);
    expect(bandFor('2026-05-01', now)).toBe(ActivityBand.LastThreeMonths);
  });

  it('reads the fourth month back as dormant', () => {
    expect(bandFor('2026-04-01', now)).toBe(ActivityBand.Dormant);
    expect(bandFor('2024-01-01', now)).toBe(ActivityBand.Dormant);
  });

  it('counts months across a year boundary', () => {
    const january = new Date('2027-01-15T12:00:00.000Z');
    expect(bandFor('2027-01-01', january)).toBe(ActivityBand.ThisMonth);
    expect(bandFor('2026-12-01', january)).toBe(ActivityBand.LastThreeMonths);
    expect(bandFor('2026-10-01', january)).toBe(ActivityBand.LastThreeMonths);
    expect(bandFor('2026-09-01', january)).toBe(ActivityBand.Dormant);
  });

  it('reads a future month as "this month" rather than dormant', () => {
    // The only way to get one is clock skew between an app instance and the
    // database. Skew must not flip a member's badge to its most damaging value.
    expect(bandFor('2026-09-01', now)).toBe(ActivityBand.ThisMonth);
  });

  it('returns null for a value that is not a date', () => {
    expect(bandFor('not-a-date', now)).toBeNull();
    expect(bandFor('2026-13-01', now)).toBeNull();
    expect(bandFor('2026-08', now)).toBeNull();
  });
});

describe('visibleBand', () => {
  const signal = { band: ActivityBand.ThisMonth, isHidden: false };

  it('shows the band when the member has not opted out', () => {
    expect(visibleBand(signal, false)).toBe(ActivityBand.ThisMonth);
  });

  it('hides an opted-out member’s band from every other member', () => {
    expect(visibleBand({ ...signal, isHidden: true }, false)).toBeNull();
  });

  it('still shows an opted-out member their OWN band', () => {
    // A privacy switch whose effect you cannot see is a switch nobody trusts.
    expect(visibleBand({ ...signal, isHidden: true }, true)).toBe(
      ActivityBand.ThisMonth,
    );
  });

  it('renders a member with no row as no band, for anyone', () => {
    expect(visibleBand(undefined, false)).toBeNull();
    expect(visibleBand(undefined, true)).toBeNull();
  });
});
