import type { EntityManager } from 'typeorm';
import {
  GAME_IMPORT_SOURCES_SQL,
  IMPORT_SOURCES_SQL,
  listOrganisedEventSources,
  listOwnedGameSources,
} from './quizshow-import-sources';

function fakeQueryable(rows: object[]): EntityManager {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as EntityManager;
}

const LISTED_ROUNDS = [
  {
    roundIndex: 0,
    kind: 'wheel',
    titleEn: 'Spin',
    titlePt: 'Roda',
    questionCount: 0,
    sliceCount: 3,
    contentLabel: 'none',
  },
  {
    roundIndex: 1,
    kind: 'quiz',
    titleEn: 'Music',
    titlePt: 'Música',
    questionCount: 8,
    sliceCount: null,
    contentLabel: 'adults',
  },
];

describe('quizshow import sources SQL', () => {
  it.each([
    ['IMPORT_SOURCES_SQL', IMPORT_SOURCES_SQL],
    ['GAME_IMPORT_SOURCES_SQL', GAME_IMPORT_SOURCES_SQL],
  ])(
    '%s counts rounds without wheel steps, with a cast that runs before the enum has the label',
    (_name, sql) => {
      const roundCountSubquery = sql.slice(0, sql.indexOf('AS "round_count"'));
      expect(roundCountSubquery).toContain(
        `AND "round"."kind"::text <> 'wheel'`,
      );
      expect(sql.match(/<> 'wheel'/g)).toHaveLength(1);
    },
  );

  it.each([
    ['IMPORT_SOURCES_SQL', IMPORT_SOURCES_SQL],
    ['GAME_IMPORT_SOURCES_SQL', GAME_IMPORT_SOURCES_SQL],
  ])(
    '%s lists every row of the quiz in position order, wheels included',
    (_name, sql) => {
      expect(sql).toContain('jsonb_agg(');
      expect(sql).toContain('ORDER BY "listed_round"."position"');
      expect(sql).toContain(`'[]'::jsonb) AS "rounds"`);
    },
  );

  it.each([
    ['IMPORT_SOURCES_SQL', IMPORT_SOURCES_SQL],
    ['GAME_IMPORT_SOURCES_SQL', GAME_IMPORT_SOURCES_SQL],
  ])('%s reads the stored slice count on wheel rows only', (_name, sql) => {
    expect(sql).toContain(`'sliceCount', CASE`);
    expect(sql).toContain(`WHEN "listed_round"."kind"::text = 'wheel'`);
    expect(sql).toContain(
      `AND jsonb_typeof("listed_round"."settings"->'sliceCount') = 'number'`,
    );
    expect(sql).toContain(
      `("listed_round"."settings"->>'sliceCount')::numeric::int`,
    );
  });
});

describe('quizshow import sources SQL content label', () => {
  it.each([
    ['IMPORT_SOURCES_SQL', IMPORT_SOURCES_SQL],
    ['GAME_IMPORT_SOURCES_SQL', GAME_IMPORT_SOURCES_SQL],
  ])('%s lists each row content label', (_name, sql) => {
    expect(sql).toContain(`'contentLabel', "listed_round"."content_label"`);
  });
});

describe('quizshow import source rounds', () => {
  it('maps the listed rows of an event source to round refs', async () => {
    const sources = await listOrganisedEventSources(
      fakeQueryable([
        {
          event_slug: 'drag-bingo',
          event_title: 'Drag bingo',
          start_at: new Date('2026-10-01T20:00:00.000Z'),
          quiz_title: 'Bingo night',
          round_count: 1,
          question_count: 8,
          has_adults_rounds: false,
          is_same_series: true,
          rounds: LISTED_ROUNDS,
        },
      ]),
      { userId: 'user-1', excludeEventSlug: null, seriesId: null },
    );
    expect(sources[0]?.rounds).toEqual([
      {
        roundIndex: 0,
        kind: 'wheel',
        title: { en: 'Spin', pt: 'Roda' },
        questionCount: 0,
        sliceCount: 3,
        contentLabel: 'none',
      },
      {
        roundIndex: 1,
        kind: 'quiz',
        title: { en: 'Music', pt: 'Música' },
        questionCount: 8,
        sliceCount: null,
        contentLabel: 'adults',
      },
    ]);
  });

  it('reads an Auto wheel as null and keeps every other row at null', async () => {
    const sources = await listOwnedGameSources(
      fakeQueryable([
        {
          game_id: 'game-2',
          quiz_title: 'Wheel game',
          round_count: 1,
          question_count: 8,
          has_adults_rounds: false,
          rounds: [
            // A row stored before the wheel settings has no slice count.
            { ...LISTED_ROUNDS[0], sliceCount: undefined },
            { ...LISTED_ROUNDS[1], sliceCount: 4 },
          ],
        },
      ]),
      { userId: 'user-1', excludeGameId: null },
    );
    expect(sources[0]?.rounds.map((round) => round.sliceCount)).toEqual([
      null,
      null,
    ]);
  });

  it('maps a listed row without a content label to none', async () => {
    const sources = await listOwnedGameSources(
      fakeQueryable([
        {
          game_id: 'game-3',
          quiz_title: 'Older rows',
          round_count: 1,
          question_count: 8,
          has_adults_rounds: false,
          rounds: [{ ...LISTED_ROUNDS[1], contentLabel: undefined }],
        },
      ]),
      { userId: 'user-1', excludeGameId: null },
    );
    expect(sources[0]?.rounds.map((round) => round.contentLabel)).toEqual([
      'none',
    ]);
  });

  it('lists no rows for a game source whose quiz has none', async () => {
    const sources = await listOwnedGameSources(
      fakeQueryable([
        {
          game_id: 'game-1',
          quiz_title: 'Empty game',
          round_count: 0,
          question_count: 0,
          has_adults_rounds: false,
          rounds: null,
        },
      ]),
      { userId: 'user-1', excludeGameId: null },
    );
    expect(sources[0]?.rounds).toEqual([]);
  });
});
