import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import {
  followerGrowthWeekStarts,
  orderReleasesForStats,
  playWindowDays,
  toArtistPlays,
  toFollowerGrowth,
  toNextRelease,
  toStudioCount,
} from './studio-stats';

const release = (
  id: string,
  status: StudioReleaseStatus,
  publishedAt: string | null,
  updatedAt: string,
): StudioRelease =>
  ({
    id,
    status,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
    updatedAt: new Date(updatedAt),
  }) as StudioRelease;

describe('toStudioCount', () => {
  it.each([
    [0, { value: 0, isBelowThreshold: false }],
    [1, { value: null, isBelowThreshold: true }],
    [4, { value: null, isBelowThreshold: true }],
    [5, { value: 5, isBelowThreshold: false }],
    [120, { value: 120, isBelowThreshold: false }],
  ])('reads %i as %p', (count, expected) => {
    expect(toStudioCount(count)).toEqual(expected);
  });
});

describe('orderReleasesForStats', () => {
  it('puts published releases first, newest first, then the rest by last edit', () => {
    const ordered = orderReleasesForStats([
      release(
        'draft-old',
        StudioReleaseStatus.Draft,
        null,
        '2026-10-01T00:00:00Z',
      ),
      release(
        'live-old',
        StudioReleaseStatus.Published,
        '2026-09-01T00:00:00Z',
        '2026-09-01T00:00:00Z',
      ),
      release(
        'down',
        StudioReleaseStatus.TakenDown,
        null,
        '2026-10-05T00:00:00Z',
      ),
      release(
        'live-new',
        StudioReleaseStatus.Published,
        '2026-10-02T00:00:00Z',
        '2026-10-02T00:00:00Z',
      ),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      'live-new',
      'live-old',
      'down',
      'draft-old',
    ]);
  });

  it('places a scheduled release among the others, by last update', () => {
    const ordered = orderReleasesForStats([
      release(
        'draft',
        StudioReleaseStatus.Draft,
        null,
        '2026-10-03T09:00:00.000Z',
      ),
      release(
        'scheduled',
        StudioReleaseStatus.Scheduled,
        null,
        '2026-10-05T09:00:00.000Z',
      ),
      release(
        'live',
        StudioReleaseStatus.Published,
        '2026-10-01T09:00:00.000Z',
        '2026-10-01T09:00:00.000Z',
      ),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      'live',
      'scheduled',
      'draft',
    ]);
  });
});

const scheduledRelease = (
  id: string,
  publishAt: string,
  title = `Release ${id}`,
): StudioRelease =>
  ({
    id,
    title,
    status: StudioReleaseStatus.Scheduled,
    publishedAt: null,
    publishAt: new Date(publishAt),
    updatedAt: new Date('2026-10-20T09:00:00.000Z'),
  }) as StudioRelease;

describe('followerGrowthWeekStarts', () => {
  it('lists twelve Mondays ending with the current week, oldest first', () => {
    const weekStarts = followerGrowthWeekStarts(
      new Date('2026-10-28T15:00:00.000Z'),
    );
    expect(weekStarts).toHaveLength(12);
    expect(weekStarts[0]).toBe('2026-08-10');
    expect(weekStarts[11]).toBe('2026-10-26');
  });

  it('starts the last week on the current Monday at midnight UTC', () => {
    expect(
      followerGrowthWeekStarts(new Date('2026-10-26T00:00:00.000Z'))[11],
    ).toBe('2026-10-26');
  });

  it('keeps a Sunday request in the week that began six days earlier', () => {
    expect(
      followerGrowthWeekStarts(new Date('2026-11-01T23:59:59.999Z'))[11],
    ).toBe('2026-10-26');
  });
});

describe('toFollowerGrowth', () => {
  it('fills missing weeks with zero and reads string counts', () => {
    const weekStarts = followerGrowthWeekStarts(
      new Date('2026-10-28T15:00:00.000Z'),
    );
    const growth = toFollowerGrowth(weekStarts, [
      { week_start: '2026-10-19', new_followers: '4' },
      { week_start: '2026-08-03', new_followers: 9 },
    ]);
    expect(growth).toHaveLength(12);
    expect(growth[10]).toEqual({ weekStart: '2026-10-19', newFollowers: 4 });
    expect(growth.reduce((total, week) => total + week.newFollowers, 0)).toBe(
      4,
    );
    expect(growth.map((week) => week.weekStart)).toEqual(weekStarts);
  });
});

describe('toNextRelease', () => {
  const publishedRelease = release(
    'live',
    StudioReleaseStatus.Published,
    '2026-10-01T09:00:00.000Z',
    '2026-10-01T09:00:00.000Z',
  );

  it('names the soonest scheduled release, ties by id', () => {
    const nextRelease = toNextRelease(
      [
        scheduledRelease('later', '2026-11-09T18:00:00.000Z'),
        scheduledRelease('tie-b', '2026-11-02T18:00:00.000Z'),
        release(
          'draft',
          StudioReleaseStatus.Draft,
          null,
          '2026-10-03T09:00:00.000Z',
        ),
        scheduledRelease('tie-a', '2026-11-02T18:00:00.000Z', 'First out'),
        publishedRelease,
      ],
      new Map([
        ['tie-a', 6],
        ['tie-b', 9],
      ]),
    );
    expect(nextRelease).toEqual({
      releaseId: 'tie-a',
      title: 'First out',
      publishAt: '2026-11-02T18:00:00.000Z',
      reminders: { value: 6, isBelowThreshold: false },
    });
  });

  it('floors its reminders like the release row', () => {
    const scheduled = scheduledRelease('soon', '2026-11-02T18:00:00.000Z');
    expect(
      toNextRelease([scheduled], new Map([[scheduled.id, 3]]))?.reminders,
    ).toEqual({ value: null, isBelowThreshold: true });
  });

  it('reads zero reminders when none are counted', () => {
    const scheduled = scheduledRelease('soon', '2026-11-02T18:00:00.000Z');
    expect(toNextRelease([scheduled], new Map())?.reminders).toEqual({
      value: 0,
      isBelowThreshold: false,
    });
  });

  it('answers null when nothing is scheduled', () => {
    expect(toNextRelease([publishedRelease], new Map())).toBeNull();
  });
});

describe('playWindowDays', () => {
  it('lists 28 UTC days ending today, oldest first', () => {
    const days = playWindowDays(new Date('2026-10-28T15:00:00.000Z'));
    expect([days.length, days[0], days[27]]).toEqual([
      28,
      '2026-10-01',
      '2026-10-28',
    ]);
  });

  it('keeps 23:59:59.999 UTC in its day and starts the next at midnight', () => {
    expect([
      playWindowDays(new Date('2026-10-28T23:59:59.999Z'))[27],
      playWindowDays(new Date('2026-10-29T00:00:00.000Z'))[27],
    ]).toEqual(['2026-10-28', '2026-10-29']);
  });

  it('crosses a month end one day at a time', () => {
    const days = playWindowDays(new Date('2026-03-01T08:00:00.000Z'));
    expect(days.slice(-3)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});

describe('toArtistPlays', () => {
  const windowDays = playWindowDays(new Date('2026-10-28T15:00:00.000Z'));

  it('floors each day on its own and the window once', () => {
    const plays = toArtistPlays(
      windowDays,
      windowDays.slice(21).map((day) => ({ day, plays: '1' })),
      7,
    );
    expect(plays.days.slice(21).map((entry) => entry.plays)).toEqual(
      Array(7).fill({ value: null, isBelowThreshold: true }),
    );
    expect([plays.total28d, plays.total]).toEqual([
      { value: 7, isBelowThreshold: false },
      { value: 7, isBelowThreshold: false },
    ]);
  });

  it('zero-fills the days without a row and leaves rows outside the window out', () => {
    const plays = toArtistPlays(
      windowDays,
      [
        { day: '2026-09-30', plays: '40' },
        { day: '2026-10-10', plays: 12 },
        { day: '2026-10-29', plays: '9' },
      ],
      61,
    );
    expect(plays.days).toHaveLength(28);
    expect(plays.days.map((entry) => entry.day)).toEqual(windowDays);
    expect(
      plays.days
        .filter((entry) => entry.plays.value !== 0)
        .map((entry) => [entry.day, entry.plays]),
    ).toEqual([['2026-10-10', { value: 12, isBelowThreshold: false }]]);
    expect(plays.total28d).toEqual({ value: 12, isBelowThreshold: false });
  });

  it('floors the all-time total', () => {
    const plays = toArtistPlays(windowDays, [], 3);
    expect([plays.total, plays.total28d]).toEqual([
      { value: null, isBelowThreshold: true },
      { value: 0, isBelowThreshold: false },
    ]);
  });
});
