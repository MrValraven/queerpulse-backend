import { normalizeLandingSource } from './landing-visit-source';
import { isBotUserAgent, LandingVisitsService } from './landing-visits.service';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const JSON_CONTENT_TYPE = 'application/json';

describe('normalizeLandingSource', () => {
  it('falls back to direct for a missing or empty source', () => {
    expect(normalizeLandingSource(undefined)).toBe('direct');
    expect(normalizeLandingSource('')).toBe('direct');
    expect(normalizeLandingSource('   ')).toBe('direct');
    expect(normalizeLandingSource('---')).toBe('direct');
  });

  it('lowercases and swaps characters outside [a-z0-9._-] for dashes', () => {
    expect(normalizeLandingSource('Instagram')).toBe('instagram');
    expect(normalizeLandingSource('News Letter/Oct')).toBe('news-letter-oct');
    expect(normalizeLandingSource('t.co')).toBe('t.co');
    expect(normalizeLandingSource('my_list-2')).toBe('my_list-2');
  });

  it('trims leading and trailing dashes', () => {
    expect(normalizeLandingSource('  !instagram! ')).toBe('instagram');
  });

  it('clamps to 64 characters', () => {
    const normalized = normalizeLandingSource('a'.repeat(200));
    expect(normalized).toHaveLength(64);
  });
});

describe('isBotUserAgent', () => {
  it('treats a missing or blank user agent as a bot', () => {
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
  });

  it('matches crawlers, unfurlers and scripts', () => {
    expect(isBotUserAgent('Googlebot/2.1')).toBe(true);
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true);
    expect(isBotUserAgent('curl/8.4.0')).toBe(true);
    expect(isBotUserAgent('HeadlessChrome/120.0')).toBe(true);
  });

  it('lets a regular browser through', () => {
    expect(isBotUserAgent(BROWSER_USER_AGENT)).toBe(false);
  });
});

describe('LandingVisitsService', () => {
  let query: jest.Mock;
  let service: LandingVisitsService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    service = new LandingVisitsService({ query } as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('record', () => {
    it('writes nothing for a bot user agent', async () => {
      await service.record('instagram', 'Twitterbot/1.0', JSON_CONTENT_TYPE);
      expect(query).not.toHaveBeenCalled();
    });

    it('writes nothing when the user agent is missing', async () => {
      await service.record('instagram', undefined, JSON_CONTENT_TYPE);
      expect(query).not.toHaveBeenCalled();
    });

    it.each([
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      undefined,
    ])(
      'writes nothing for a non-JSON content type (%s)',
      async (contentType) => {
        await service.record('instagram', BROWSER_USER_AGENT, contentType);
        expect(query).not.toHaveBeenCalled();
      },
    );

    it('counts a JSON content type in any case, charset included', async () => {
      await service.record(
        'instagram',
        BROWSER_USER_AGENT,
        'Application/JSON; charset=utf-8',
      );
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('upserts the UTC day and the normalized source', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-26T23:30:00Z'));
      await service.record('Instagram', BROWSER_USER_AGENT, JSON_CONTENT_TYPE);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO "landing_visit_daily"');
      expect(sql).toContain('ON CONFLICT ("day", "source")');
      expect(sql).toContain('"landing_visit_daily"."visits" + 1');
      expect(parameters).toEqual(['2026-10-26', 'instagram']);
    });

    it('never passes the user agent to the database', async () => {
      await service.record(undefined, BROWSER_USER_AGENT, JSON_CONTENT_TYPE);
      const [, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(parameters).not.toContain(BROWSER_USER_AGENT);
      expect(parameters[1]).toBe('direct');
    });
  });

  describe('getStats', () => {
    it.each([30, 90] as const)(
      'returns exactly %i zero-filled days, oldest first, ending today',
      async (rangeDays) => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00Z'));
        const stats = await service.getStats(rangeDays);
        expect(stats.days).toHaveLength(rangeDays);
        expect(stats.days.at(-1)?.day).toBe('2026-10-26');
        const sortedDays = [...stats.days.map((entry) => entry.day)].sort();
        expect(stats.days.map((entry) => entry.day)).toEqual(sortedDays);
        expect(stats.days.every((entry) => entry.visits === 0)).toBe(true);
        expect(stats.total).toBe(0);
        expect(stats.rangeDays).toBe(rangeDays);
      },
    );

    it('fills stored days in place and sums the total', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00Z'));
      query
        .mockResolvedValueOnce([
          { day: '2026-10-25', visits: '4' },
          { day: '2026-10-26', visits: '3' },
        ])
        .mockResolvedValueOnce([
          { source: 'instagram', visits: '5' },
          { source: 'direct', visits: '2' },
        ]);
      const stats = await service.getStats(30);
      expect(stats.days[0]?.day).toBe('2026-09-27');
      expect(stats.days[28]).toEqual({ day: '2026-10-25', visits: 4 });
      expect(stats.days[29]).toEqual({ day: '2026-10-26', visits: 3 });
      expect(stats.total).toBe(7);
      expect(stats.topSources).toEqual([
        { source: 'instagram', visits: 5 },
        { source: 'direct', visits: 2 },
      ]);
      const [, dailyParameters] = query.mock.calls[0] as [string, unknown[]];
      expect(dailyParameters).toEqual(['2026-09-27']);
      const [, sourceParameters] = query.mock.calls[1] as [string, unknown[]];
      expect(sourceParameters).toEqual(['2026-09-27', 10]);
    });
  });
});
