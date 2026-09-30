import {
  ITEM_DESCRIPTION_MAX,
  ITEM_TITLE_MAX,
  episodeSubtitle,
  episodeToItemFields,
  formatDurationMeta,
  monthOf,
  safeItemUrl,
} from './feed-item-mapping';

describe('episodeSubtitle', () => {
  it.each([
    [2, 14, 'S2 · E14'],
    [null, 14, 'E14'],
    [0, 3, 'S0 · E3'],
    [2, null, null],
    [null, null, null],
  ])('season %s, episode %s -> %s', (season, episode, expected) => {
    expect(episodeSubtitle(season, episode)).toBe(expected);
  });
});

describe('formatDurationMeta', () => {
  it.each([
    [48 * 60, '48 min'],
    [72 * 60 + 3, '1 h 12 min'],
    [2 * 3600, '2 h'],
    [2 * 3600 + 29, '2 h'],
    [59 * 60 + 40, '1 h'],
    [20, '1 min'],
    [89, '1 min'],
    [90, '2 min'],
  ])('%s s -> %s', (seconds, expected) => {
    expect(formatDurationMeta(seconds)).toBe(expected);
  });

  it.each([[null], [0], [-5], [Number.NaN]])('%s -> null', (seconds) => {
    expect(formatDurationMeta(seconds)).toBeNull();
  });
});

describe('monthOf', () => {
  it('formats yyyy-mm in UTC', () => {
    expect(monthOf(new Date('2025-06-10T04:00:00Z'))).toBe('2025-06');
    // 23:30 on 31 Dec in New York is already January in UTC.
    expect(monthOf(new Date('2024-12-31T23:30:00-05:00'))).toBe('2025-01');
  });

  it('is null without a usable date', () => {
    expect(monthOf(null)).toBeNull();
    expect(monthOf(new Date('nope'))).toBeNull();
  });
});

describe('safeItemUrl', () => {
  it('keeps an https link', () => {
    expect(safeItemUrl('https://show.example/ep-1')).toBe(
      'https://show.example/ep-1',
    );
  });

  it.each([
    ['http://show.example/ep-1'],
    ['javascript:alert(1)'],
    [`https://show.example/${'x'.repeat(1000)}`],
    [null],
  ])('drops %s', (link) => {
    expect(safeItemUrl(link)).toBeNull();
  });
});

describe('episodeToItemFields', () => {
  it('maps an episode onto an item', () => {
    expect(
      episodeToItemFields(
        {
          title: 'Pride & Prejudice',
          description: 'Notes',
          link: 'https://show.example/ep-14',
          publishedAt: new Date('2025-06-10T04:00:00Z'),
          durationSeconds: 72 * 60,
          season: 2,
          episode: 14,
        },
        'work/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg',
      ),
    ).toEqual({
      title: 'Pride & Prejudice',
      subtitle: 'S2 · E14',
      description: 'Notes',
      url: 'https://show.example/ep-14',
      date: '2025-06',
      meta: '1 h 12 min',
      imageUrl:
        'work/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg',
    });
  });

  it('truncates to the section-save caps and nulls what is missing', () => {
    const fields = episodeToItemFields(
      {
        title: 't'.repeat(400),
        description: 'd'.repeat(6000),
        link: null,
        publishedAt: null,
        durationSeconds: null,
        season: null,
        episode: null,
      },
      null,
    );
    expect(fields.title).toHaveLength(ITEM_TITLE_MAX);
    expect(fields.description).toHaveLength(ITEM_DESCRIPTION_MAX);
    expect(fields).toEqual(
      expect.objectContaining({
        subtitle: null,
        url: null,
        date: null,
        meta: null,
        imageUrl: null,
      }),
    );
  });
});
