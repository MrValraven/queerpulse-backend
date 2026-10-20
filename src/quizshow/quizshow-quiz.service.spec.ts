import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';
import { setImageUrlBase } from '../common/image-url';
import { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import { quizshowCodeOf, quizshowError } from './quizshow-errors';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { QUIZSHOW_STARTER_PACKS } from './quizshow-starter-packs';
import type { QuizshowQuizInputDto } from './dto/quizshow-quiz-input.dto';
import type { QuizshowImportDto } from './dto/quizshow-import.dto';
import type {
  QuizshowQuestionInput,
  QuizshowRoundInput,
  QuizshowStarterPackQuiz,
} from './quizshow.contract';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const GAME_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_GAME_ID = '00000000-0000-4000-8000-0000000000b2';
const EVENT_ID = 'event-1';
const SLUG = 'drag-bingo';
const STORED_UPDATED_AT = new Date('2026-10-19T10:00:00.000Z');
const OWN_IMAGE = `event-covers/${USER_ID}/00000000-0000-4000-8000-000000000001.jpg`;
const FOREIGN_IMAGE =
  'event-covers/00000000-0000-4000-8000-0000000000aa/00000000-0000-4000-8000-000000000002.jpg';

function multipleChoiceQuestion(
  overrides: Partial<QuizshowQuestionInput> = {},
): QuizshowQuestionInput {
  return {
    type: 'multiple_choice',
    prompt: { en: 'Which one?', pt: 'Qual?' },
    mediaRef: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [
      { id: 'a', text: { en: 'One', pt: 'Um' } },
      { id: 'b', text: { en: 'Two', pt: 'Dois' } },
    ],
    answer: { correctIndex: 0 },
    acceptedAnswers: [],
    ...overrides,
  } as QuizshowQuestionInput;
}

function round(
  overrides: Partial<QuizshowRoundInput> = {},
  questions: QuizshowQuestionInput[] = [multipleChoiceQuestion()],
): QuizshowRoundInput {
  return {
    kind: 'quiz',
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    },
    questions,
    ...overrides,
  };
}

function quizInput(
  overrides: Partial<QuizshowQuizInputDto> = {},
): QuizshowQuizInputDto {
  return {
    expectedUpdatedAt: null,
    title: 'Bingo night',
    languages: 'both',
    screenLanguage: 'en',
    rounds: [round()],
    ...overrides,
  } as unknown as QuizshowQuizInputDto;
}

function gameShape(
  rounds: QuizshowRoundInput[] = [round()],
): QuizshowStarterPackQuiz {
  return {
    title: 'Game night',
    languages: 'both',
    screenLanguage: 'en',
    rounds,
  };
}

interface FakeStore {
  quizzes: QuizshowQuizRecord[];
  rounds: QuizshowRoundRecord[];
  questions: QuizshowQuestionRecord[];
}

function build(options: { isAdultsEvent?: boolean } = {}) {
  const store: FakeStore = { quizzes: [], rounds: [], questions: [] };
  const event = { id: EVENT_ID, slug: SLUG, seriesId: 'series-1' };
  const access = {
    loadViewableEvent: jest.fn().mockResolvedValue({ event }),
    assertOrganiser: jest.fn().mockResolvedValue(undefined),
    assertNotCohostPlaying: jest.fn().mockResolvedValue(undefined),
    isAdultsEvent: jest.fn().mockReturnValue(options.isAdultsEvent === true),
    // Mirrors Task 12: a game the caller owns, else game not found.
    loadOwnedGame: jest.fn((gameId: string, userId: string) => {
      const ownedGame = store.quizzes.find(
        (quiz) => quiz.id === gameId && quiz.ownerUserId === userId,
      );
      return ownedGame
        ? Promise.resolve(ownedGame)
        : Promise.reject(quizshowError('quizshow_game_not_found'));
    }),
  };
  const insertQuizFailure: {
    error: Error | null;
    beforeReject: (() => void) | null;
  } = { error: null, beforeReject: null };
  const manager = {
    findOne: jest.fn((entity: unknown, query: { where: object }) => {
      const where = query.where as Record<string, string>;
      if (entity === QuizshowQuizRecord) {
        return Promise.resolve(
          store.quizzes.find((quiz) =>
            Object.entries(where).every(
              ([column, value]) =>
                (quiz as unknown as Record<string, unknown>)[column] === value,
            ),
          ) ?? null,
        );
      }
      return Promise.resolve(null);
    }),
    find: jest.fn((entity: unknown, query: { where: object }) => {
      const where = query.where as Record<string, string>;
      if (entity === QuizshowRoundRecord) {
        return Promise.resolve(
          store.rounds.filter((stored) => stored.quizId === where.quizId),
        );
      }
      return Promise.resolve([]);
    }),
    createQueryBuilder: jest.fn(() => {
      let roundIds: string[] = [];
      const builder = {
        where: (_clause: string, parameters: { roundIds: string[] }) => {
          roundIds = parameters.roundIds;
          return builder;
        },
        orderBy: () => builder,
        getMany: () =>
          Promise.resolve(
            store.questions.filter((stored) =>
              roundIds.includes(stored.roundId),
            ),
          ),
      };
      return builder;
    }),
    insert: jest.fn((entity: unknown, rows: object | object[]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      if (entity === QuizshowQuizRecord) {
        if (insertQuizFailure.error) {
          insertQuizFailure.beforeReject?.();
          return Promise.reject(insertQuizFailure.error);
        }
        const inserted = {
          id: 'quiz-new',
          ...list[0],
        } as unknown as QuizshowQuizRecord;
        store.quizzes.push(inserted);
        return Promise.resolve({ identifiers: [{ id: inserted.id }] });
      }
      if (entity === QuizshowRoundRecord) {
        store.rounds.push(...(list as QuizshowRoundRecord[]));
      } else {
        store.questions.push(...(list as QuizshowQuestionRecord[]));
      }
      return Promise.resolve({ identifiers: [] });
    }),
    update: jest.fn(
      (_entity: unknown, criteria: { id: string }, columns: object) => {
        const stored = store.quizzes.find((quiz) => quiz.id === criteria.id);
        if (stored) Object.assign(stored, columns);
        return Promise.resolve();
      },
    ),
    delete: jest.fn(() => {
      const removedRoundIds = store.rounds.map((stored) => stored.id);
      store.rounds = [];
      store.questions = store.questions.filter(
        (stored) => !removedRoundIds.includes(stored.roundId),
      );
      return Promise.resolve();
    }),
  };
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const queryResults = {
    state: [
      {
        session_id: null,
        join_code: null,
        status: null,
        play_mode: null,
        started_at: null,
        player_count: null,
        has_results: false,
      },
    ] as object[],
    organisedEvent: [] as object[],
    importSources: [] as object[],
    gameSources: [] as object[],
  };
  const dataSource = {
    manager,
    transaction: jest.fn((callback: (entityManager: unknown) => unknown) =>
      Promise.resolve(callback(manager)),
    ),
    query: jest.fn((sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      if (sql.includes('"open_session"')) {
        return Promise.resolve(queryResults.state);
      }
      if (sql.includes('AS "event_id"')) {
        return Promise.resolve(queryResults.organisedEvent);
      }
      if (sql.includes('"quiz"."owner_user_id" = $1')) {
        return Promise.resolve(queryResults.gameSources);
      }
      return Promise.resolve(queryResults.importSources);
    }),
  };
  const service = new QuizshowQuizService(
    dataSource as unknown as DataSource,
    access as never,
  );
  return {
    service,
    store,
    access,
    manager,
    dataSource,
    queries,
    queryResults,
    insertQuizFailure,
  };
}

function seedStoredQuiz(
  store: FakeStore,
  overrides: Partial<QuizshowQuizRecord> = {},
  mediaRef: string | null = null,
): void {
  store.quizzes.push({
    id: 'quiz-1',
    eventId: EVENT_ID,
    ownerUserId: null,
    isAdultsOnly: false,
    title: 'Stored',
    languages: 'both',
    screenLanguage: 'en',
    starterPackKey: 'eurovision',
    createdByUserId: USER_ID,
    updatedByUserId: USER_ID,
    createdAt: STORED_UPDATED_AT,
    updatedAt: STORED_UPDATED_AT,
    ...overrides,
  });
  store.rounds.push({
    id: 'round-1',
    quizId: 'quiz-1',
    position: 0,
    kind: 'quiz',
    titleEn: 'Round',
    titlePt: 'Ronda',
    contentLabel: 'none',
    settings: round().settings,
  });
  store.questions.push({
    id: 'question-1',
    roundId: 'round-1',
    position: 0,
    type: 'multiple_choice',
    promptEn: 'Which one?',
    promptPt: 'Qual?',
    mediaRef,
    options: multipleChoiceQuestion().options,
    answer: { correctIndex: 0 },
    acceptedAnswers: [],
    timeLimitSeconds: null,
    points: 1000,
  });
}

function seedStoredGame(
  store: FakeStore,
  game: {
    id: string;
    ownerUserId: string;
    isAdultsOnly?: boolean;
    contentLabel?: QuizshowRoundInput['contentLabel'];
  },
): void {
  const roundId = `${game.id}-round`;
  store.quizzes.push({
    id: game.id,
    eventId: null,
    ownerUserId: game.ownerUserId,
    isAdultsOnly: game.isAdultsOnly === true,
    title: 'Stored game',
    languages: 'both',
    screenLanguage: 'en',
    starterPackKey: 'pride_history',
    createdByUserId: game.ownerUserId,
    updatedByUserId: game.ownerUserId,
    createdAt: STORED_UPDATED_AT,
    updatedAt: STORED_UPDATED_AT,
  });
  store.rounds.push({
    id: roundId,
    quizId: game.id,
    position: 0,
    kind: 'quiz',
    titleEn: 'Game round',
    titlePt: 'Ronda do jogo',
    contentLabel: game.contentLabel ?? 'none',
    settings: round().settings,
  });
  store.questions.push({
    id: `${game.id}-question`,
    roundId,
    position: 0,
    type: 'multiple_choice',
    promptEn: 'Which one?',
    promptPt: 'Qual?',
    mediaRef: null,
    options: multipleChoiceQuestion().options,
    answer: { correctIndex: 0 },
    acceptedAnswers: [],
    timeLimitSeconds: null,
    points: 1000,
  });
}

function codeOfThrow(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return quizshowCodeOf(error);
  }
  return null;
}

async function codeOfRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to be refused');
}

function bodyOf(error: unknown): Record<string, unknown> {
  return (
    error as { getResponse: () => Record<string, unknown> }
  ).getResponse();
}

describe('QuizshowQuizService', () => {
  beforeAll(() => {
    setImageUrlBase('https://api.example.test');
  });

  it('returns a null quiz with no problems before the first save', async () => {
    const { service } = build();

    const response = await service.getQuiz(SLUG, USER_ID);

    expect(response.quiz).toBeNull();
    expect(response.problems).toEqual([]);
    expect(response.liveSession).toBeNull();
    expect(response.hasResults).toBe(false);
    expect(response.isAdultsEvent).toBe(false);
  });

  it('lists completeness problems on every read', async () => {
    const { service, store } = build();
    seedStoredQuiz(store, { title: '   ' });

    const response = await service.getQuiz(SLUG, USER_ID);

    expect(response.quiz?.rounds[0]?.questions[0]?.id).toBe('question-1');
    expect(response.problems.map((problem) => problem.code)).toContain(
      'title_missing',
    );
  });

  it('refuses the quiz to a co-host who is playing an open session', async () => {
    const { service, access } = build();
    access.assertNotCohostPlaying.mockRejectedValue(
      quizshowError('quizshow_cohost_is_playing'),
    );

    const error = await codeOfRejection(service.getQuiz(SLUG, USER_ID));

    expect(quizshowCodeOf(error)).toBe('quizshow_cohost_is_playing');
    expect(access.assertNotCohostPlaying).toHaveBeenCalledWith(
      EVENT_ID,
      USER_ID,
    );
  });

  it('saves a draft and returns new round and question ids', async () => {
    const { service, store } = build();

    const response = await service.replaceQuiz(SLUG, USER_ID, quizInput());

    expect(store.quizzes).toHaveLength(1);
    expect(store.quizzes[0]?.createdByUserId).toBe(USER_ID);
    expect(store.rounds).toHaveLength(1);
    expect(store.questions).toHaveLength(1);
    const savedRound = response.quiz?.rounds[0];
    expect(savedRound?.id).toBe(store.rounds[0]?.id);
    expect(savedRound?.questions[0]?.id).toBe(store.questions[0]?.id);
    expect(response.quiz?.title).toBe('Bingo night');
  });

  it('refuses a stale expected updatedAt with the stored one', async () => {
    const { service, store } = build();
    seedStoredQuiz(store);

    const error = await codeOfRejection(
      service.replaceQuiz(
        SLUG,
        USER_ID,
        quizInput({ expectedUpdatedAt: '2026-10-19T09:00:00.000Z' }),
      ),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_quiz_changed');
    expect(bodyOf(error).updatedAt).toBe(STORED_UPDATED_AT.toISOString());
    expect(store.quizzes[0]?.title).toBe('Stored');
  });

  it('answers a racing first save with the same conflict', async () => {
    const { service, store, insertQuizFailure } = build();
    const winner = new Date('2026-10-19T10:30:00.000Z');
    insertQuizFailure.error = new QueryFailedError('INSERT', [], {
      code: '23505',
      constraint: 'UQ_quizshow_quizzes_event_id',
    } as unknown as Error);
    // The winning save commits between this save's read and its insert.
    insertQuizFailure.beforeReject = () => {
      store.quizzes.push({
        id: 'quiz-winner',
        eventId: EVENT_ID,
        ownerUserId: null,
        isAdultsOnly: false,
        title: 'Winner',
        languages: 'both',
        screenLanguage: 'en',
        starterPackKey: null,
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: winner,
        updatedAt: winner,
      });
    };

    const error = await codeOfRejection(
      service.replaceQuiz(SLUG, USER_ID, quizInput()),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_quiz_changed');
    expect(bodyOf(error).updatedAt).toBe(winner.toISOString());
  });

  it('refuses structural problems with the list', async () => {
    const { service, store } = build();
    const tooFewOptions = multipleChoiceQuestion({
      options: [{ id: 'a', text: { en: 'One', pt: 'Um' } }],
    });

    const error = await codeOfRejection(
      service.replaceQuiz(
        SLUG,
        USER_ID,
        quizInput({ rounds: [round({}, [tooFewOptions])] }),
      ),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_quiz_invalid');
    expect(Array.isArray(bodyOf(error).problems)).toBe(true);
    expect((bodyOf(error).problems as unknown[]).length).toBeGreaterThan(0);
    expect(store.quizzes).toHaveLength(0);
  });

  it('refuses an adults round on an event without the 18+ flag', async () => {
    const { service, store } = build({ isAdultsEvent: false });

    const error = await codeOfRejection(
      service.replaceQuiz(
        SLUG,
        USER_ID,
        quizInput({ rounds: [round({ contentLabel: 'adults' })] }),
      ),
    );

    expect(quizshowCodeOf(error)).toBe(
      'quizshow_adults_round_needs_adults_event',
    );
    expect(store.quizzes).toHaveLength(0);
  });

  it('refuses a foreign image that the quiz does not already hold', async () => {
    const { service, store } = build();
    const withForeignImage = quizInput({
      rounds: [
        round({}, [multipleChoiceQuestion({ mediaRef: FOREIGN_IMAGE })]),
      ],
    });

    await expect(
      service.replaceQuiz(SLUG, USER_ID, withForeignImage),
    ).rejects.toThrow('Referenced upload does not belong to you');
    expect(store.quizzes).toHaveLength(0);

    seedStoredQuiz(store, {}, FOREIGN_IMAGE);
    const held = quizInput({
      expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
      rounds: [
        round({}, [multipleChoiceQuestion({ mediaRef: FOREIGN_IMAGE })]),
      ],
    });
    const response = await service.replaceQuiz(SLUG, USER_ID, held);
    expect(response.quiz?.rounds[0]?.questions[0]?.mediaRef).toBe(
      FOREIGN_IMAGE,
    );
    const own = quizInput({
      expectedUpdatedAt: response.quiz?.updatedAt ?? null,
      rounds: [round({}, [multipleChoiceQuestion({ mediaRef: OWN_IMAGE })])],
    });
    await expect(
      service.replaceQuiz(SLUG, USER_ID, own),
    ).resolves.toBeDefined();
  });

  it("imports a pack with its key and an event's quiz with its key", async () => {
    const { service, store } = build();
    const pack = QUIZSHOW_STARTER_PACKS[0];
    if (!pack) throw new Error('The catalog holds no pack');

    const packResponse = await service.importQuiz(SLUG, USER_ID, {
      from: 'pack',
      packKey: pack.key,
    });

    expect(packResponse.quiz?.starterPackKey).toBe(pack.key);
    expect(store.quizzes[0]?.starterPackKey).toBe(pack.key);

    const second = build();
    seedStoredQuiz(second.store, {
      eventId: 'source-event',
      starterPackKey: 'drag_herstory',
    });
    second.queryResults.organisedEvent = [{ event_id: 'source-event' }];
    const eventResponse = await second.service.importQuiz(SLUG, USER_ID, {
      from: 'event',
      eventSlug: 'last-bingo',
    });

    expect(eventResponse.quiz?.starterPackKey).toBe('drag_herstory');
    expect(eventResponse.quiz?.rounds).toHaveLength(1);
  });

  it('refuses an import from the same event and from an event the caller does not organise', async () => {
    const { service, queryResults } = build();

    const sameEvent = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, {
        from: 'event',
        eventSlug: SLUG,
      }),
    );
    expect(quizshowCodeOf(sameEvent)).toBe('quizshow_import_same_event');

    queryResults.organisedEvent = [];
    const foreign = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, {
        from: 'event',
        eventSlug: 'someone-elses',
      }),
    );
    expect(quizshowCodeOf(foreign)).toBe('quizshow_import_source_not_found');

    const unknownPack = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, {
        from: 'pack',
        packKey: 'not_a_pack',
      } as unknown as QuizshowImportDto),
    );
    expect(quizshowCodeOf(unknownPack)).toBe('quizshow_pack_not_found');
  });

  it('lists import sources with the series flag, newest first', async () => {
    const { service, queryResults, queries } = build();
    queryResults.importSources = [
      {
        event_slug: 'newer',
        event_title: 'Newer',
        start_at: new Date('2026-10-01T20:00:00.000Z'),
        quiz_title: 'Quiz A',
        round_count: 3,
        question_count: 15,
        has_adults_rounds: false,
        is_same_series: true,
      },
      {
        event_slug: 'older',
        event_title: 'Older',
        start_at: new Date('2026-09-01T20:00:00.000Z'),
        quiz_title: 'Quiz B',
        round_count: 2,
        question_count: 8,
        has_adults_rounds: true,
        is_same_series: false,
      },
    ];

    const result = await service.listImportSources(SLUG, USER_ID);

    expect(result.items.map((item) => item.eventSlug)).toEqual([
      'newer',
      'older',
    ]);
    expect(result.items[0]?.isSameSeries).toBe(true);
    expect(result.items[0]?.startAt).toBe('2026-10-01T20:00:00.000Z');
    expect(result.items[1]?.hasAdultsRounds).toBe(true);
    const sourcesQuery = queries.find((entry) =>
      entry.sql.includes('ORDER BY "event"."start_at" DESC'),
    );
    expect(sourcesQuery?.sql).toContain('LIMIT $4');
    expect(sourcesQuery?.sql).toContain('COALESCE($3::uuid IS NOT NULL');
    expect(sourcesQuery?.sql).toContain(
      '"event"."start_at" DESC, "event"."id"',
    );
    expect(result.items[1]?.isSameSeries).toBe(false);
    expect(sourcesQuery?.parameters).toEqual([SLUG, USER_ID, 'series-1', 50]);
  });

  it('lists the packs with no questions', () => {
    const { service } = build();

    const { items } = service.listPacks();

    expect(items).toHaveLength(QUIZSHOW_STARTER_PACKS.length);
    for (const card of items) {
      expect(card).not.toHaveProperty('quiz');
      expect(JSON.stringify(card)).not.toContain('"questions"');
      expect(card.questionCount).toBeGreaterThan(0);
    }
  });

  it('imports a game the caller owns into an event', async () => {
    const { service, store, access } = build();
    seedStoredGame(store, { id: GAME_ID, ownerUserId: USER_ID });

    const response = await service.importQuiz(SLUG, USER_ID, {
      from: 'game',
      gameId: GAME_ID,
    });

    expect(access.loadOwnedGame).toHaveBeenCalledWith(GAME_ID, USER_ID);
    const eventQuiz = store.quizzes.find((quiz) => quiz.eventId === EVENT_ID);
    expect(eventQuiz?.title).toBe('Stored game');
    expect(eventQuiz?.starterPackKey).toBe('pride_history');
    expect(eventQuiz?.ownerUserId).toBeUndefined();
    expect(response.quiz?.title).toBe('Stored game');
    expect(response.quiz?.rounds).toHaveLength(1);
    expect(response.quiz?.rounds[0]?.title.en).toBe('Game round');
    expect(store.quizzes.find((quiz) => quiz.id === GAME_ID)?.title).toBe(
      'Stored game',
    );
  });

  it("refuses another member's game as an import source with source not found", async () => {
    const { service, store } = build();
    seedStoredGame(store, { id: GAME_ID, ownerUserId: OTHER_USER_ID });

    const error = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, { from: 'game', gameId: GAME_ID }),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_import_source_not_found');
    expect(store.quizzes.some((quiz) => quiz.eventId === EVENT_ID)).toBe(false);
  });

  it('refuses a game as its own import source without reading it', async () => {
    const { service, store, access } = build();
    seedStoredGame(store, { id: GAME_ID, ownerUserId: USER_ID });

    const error = await codeOfRejection(
      service.resolveImportShape({ from: 'game', gameId: GAME_ID }, USER_ID, {
        eventSlug: null,
        gameId: GAME_ID,
      }),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_import_source_not_found');
    expect(access.loadOwnedGame).not.toHaveBeenCalled();
  });

  it('refuses an adults round from a game source into a non-18+ event with the event code', async () => {
    const { service, store } = build({ isAdultsEvent: false });
    seedStoredGame(store, {
      id: GAME_ID,
      ownerUserId: USER_ID,
      isAdultsOnly: true,
      contentLabel: 'adults',
    });

    const error = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, { from: 'game', gameId: GAME_ID }),
    );

    expect(quizshowCodeOf(error)).toBe(
      'quizshow_adults_round_needs_adults_event',
    );
    expect(store.quizzes.some((quiz) => quiz.eventId === EVENT_ID)).toBe(false);
  });

  it("lists the caller's own games after the events in the event import sources", async () => {
    const { service, queryResults, queries } = build();
    queryResults.importSources = [
      {
        event_slug: 'last-bingo',
        event_title: 'Last bingo',
        start_at: new Date('2026-10-01T20:00:00.000Z'),
        quiz_title: 'Event quiz',
        round_count: 3,
        question_count: 15,
        has_adults_rounds: false,
        is_same_series: true,
      },
    ];
    queryResults.gameSources = [
      {
        game_id: GAME_ID,
        quiz_title: 'Game quiz',
        round_count: 2,
        question_count: 6,
        has_adults_rounds: true,
      },
    ];

    const result = await service.listImportSources(SLUG, USER_ID);

    expect(result.items.map((item) => item.kind)).toEqual(['event', 'game']);
    expect(result.items[0]).toMatchObject({
      kind: 'event',
      eventSlug: 'last-bingo',
      gameId: null,
      isSameSeries: true,
    });
    expect(result.items[1]).toEqual({
      kind: 'game',
      eventSlug: null,
      eventTitle: null,
      startAt: null,
      gameId: GAME_ID,
      quizTitle: 'Game quiz',
      roundCount: 2,
      questionCount: 6,
      hasAdultsRounds: true,
      isSameSeries: false,
    });
    const gamesQuery = queries.find((entry) =>
      entry.sql.includes('"quiz"."owner_user_id" = $1'),
    );
    expect(gamesQuery?.parameters).toEqual([USER_ID, null, 50]);
    expect(gamesQuery?.sql).toContain('ORDER BY "quiz"."updated_at" DESC');
  });

  it('lists other games and organised events for a game and leaves the game itself out', async () => {
    const { service, queryResults, queries, access } = build();
    queryResults.importSources = [
      {
        event_slug: 'last-bingo',
        event_title: 'Last bingo',
        start_at: '2026-10-01T20:00:00.000Z',
        quiz_title: 'Event quiz',
        round_count: 3,
        question_count: 15,
        has_adults_rounds: false,
        is_same_series: false,
      },
    ];
    queryResults.gameSources = [
      {
        game_id: OTHER_GAME_ID,
        quiz_title: 'Other game',
        round_count: 1,
        question_count: 4,
        has_adults_rounds: false,
      },
    ];

    const items = await service.listGameImportSources(GAME_ID, USER_ID);

    expect(items.map((item) => item.eventSlug ?? item.gameId)).toEqual([
      'last-bingo',
      OTHER_GAME_ID,
    ]);
    const eventsQuery = queries.find((entry) =>
      entry.sql.includes('ORDER BY "event"."start_at" DESC'),
    );
    expect(eventsQuery?.parameters).toEqual([null, USER_ID, null, 50]);
    expect(eventsQuery?.sql).toContain(
      '($1::text IS NULL OR "event"."slug" <> $1)',
    );
    const gamesQuery = queries.find((entry) =>
      entry.sql.includes('"quiz"."owner_user_id" = $1'),
    );
    expect(gamesQuery?.parameters).toEqual([USER_ID, GAME_ID, 50]);
    expect(gamesQuery?.sql).toContain(
      '($2::uuid IS NULL OR "quiz"."id" <> $2::uuid)',
    );
    expect(access.loadViewableEvent).not.toHaveBeenCalled();
  });

  it('writes a game target by id with its 18+ switch', async () => {
    const { service, store, manager } = build();
    seedStoredGame(store, { id: GAME_ID, ownerUserId: USER_ID });

    const quizId = await service.writeQuiz({
      target: { kind: 'game', gameId: GAME_ID, isAdultsOnly: true },
      userId: USER_ID,
      shape: gameShape([round({ contentLabel: 'adults' })]),
      starterPackKey: null,
      expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
    });

    expect(quizId).toBe(GAME_ID);
    expect(manager.findOne).toHaveBeenCalledWith(QuizshowQuizRecord, {
      where: { id: GAME_ID },
      lock: { mode: 'for_no_key_update' },
    });
    expect(store.quizzes).toHaveLength(1);
    expect(store.quizzes[0]).toMatchObject({
      id: GAME_ID,
      eventId: null,
      ownerUserId: USER_ID,
      isAdultsOnly: true,
      title: 'Game night',
      updatedByUserId: USER_ID,
    });
    expect(store.rounds.map((stored) => stored.contentLabel)).toEqual([
      'adults',
    ]);
    expect(store.rounds[0]?.quizId).toBe(GAME_ID);
  });

  it('refuses an adults round for a game target whose switch is off with the game code', () => {
    const { service } = build({ isAdultsEvent: true });
    const adultsShape = gameShape([round({ contentLabel: 'adults' })]);

    expect(
      codeOfThrow(() =>
        service.assertShapeAllowed(
          { kind: 'game', gameId: GAME_ID, isAdultsOnly: false },
          adultsShape,
        ),
      ),
    ).toBe('quizshow_game_adults_rounds_need_switch');
    expect(
      codeOfThrow(() =>
        service.assertShapeAllowed(
          { kind: 'new_game', ownerUserId: USER_ID, isAdultsOnly: false },
          adultsShape,
        ),
      ),
    ).toBe('quizshow_game_adults_rounds_need_switch');
    expect(
      codeOfThrow(() =>
        service.assertShapeAllowed(
          { kind: 'game', gameId: GAME_ID, isAdultsOnly: true },
          adultsShape,
        ),
      ),
    ).toBeNull();
  });

  it('creates a new game row with its owner inside the given transaction and returns its id', async () => {
    const { service, store, manager, dataSource } = build();
    const passedInsert = jest.fn((entity: unknown, rows: object | object[]) =>
      manager.insert(entity, rows),
    );
    const passedManager = { ...manager, insert: passedInsert };

    const quizId = await service.writeQuiz(
      {
        target: { kind: 'new_game', ownerUserId: USER_ID, isAdultsOnly: true },
        userId: USER_ID,
        shape: gameShape([round({ contentLabel: 'adults' })]),
        starterPackKey: null,
        expectedUpdatedAt: undefined,
      },
      passedManager as unknown as EntityManager,
    );

    expect(quizId).toBe('quiz-new');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(passedInsert).toHaveBeenCalledWith(
      QuizshowQuizRecord,
      expect.objectContaining({
        ownerUserId: USER_ID,
        eventId: null,
        createdByUserId: USER_ID,
        isAdultsOnly: true,
        title: 'Game night',
      }),
    );
    expect(passedInsert).toHaveBeenCalledWith(
      QuizshowRoundRecord,
      expect.any(Array),
    );
    expect(store.rounds[0]?.quizId).toBe('quiz-new');
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('answers game not found when a game target row is gone', async () => {
    const { service, manager } = build();

    const error = await codeOfRejection(
      service.writeQuiz({
        target: { kind: 'game', gameId: GAME_ID, isAdultsOnly: false },
        userId: USER_ID,
        shape: gameShape(),
        starterPackKey: null,
        expectedUpdatedAt: undefined,
      }),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_game_not_found');
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('builds a game response whose isAdultsEvent mirrors isAdultsOnly', async () => {
    const { service, store, queryResults, queries, access } = build();
    seedStoredGame(store, {
      id: GAME_ID,
      ownerUserId: USER_ID,
      isAdultsOnly: true,
    });
    seedStoredGame(store, {
      id: OTHER_GAME_ID,
      ownerUserId: USER_ID,
      isAdultsOnly: false,
    });
    queryResults.state = [
      {
        session_id: 'session-1',
        join_code: 'ABC123',
        status: 'lobby',
        play_mode: 'solo',
        started_at: new Date('2026-10-20T19:00:00.000Z'),
        player_count: 4,
        has_results: true,
      },
    ];

    const adultsResponse = await service.buildGameResponse(GAME_ID);
    const switchOffResponse = await service.buildGameResponse(OTHER_GAME_ID);

    expect(adultsResponse.gameId).toBe(GAME_ID);
    expect(adultsResponse.isAdultsOnly).toBe(true);
    expect(adultsResponse.isAdultsEvent).toBe(true);
    expect(adultsResponse.quiz?.title).toBe('Stored game');
    expect(adultsResponse.liveSession).toEqual({
      sessionId: 'session-1',
      joinCode: 'ABC123',
      status: 'lobby',
      playMode: 'solo',
      playerCount: 4,
      startedAt: '2026-10-20T19:00:00.000Z',
    });
    expect(adultsResponse.hasResults).toBe(true);
    expect(switchOffResponse.isAdultsOnly).toBe(false);
    expect(switchOffResponse.isAdultsEvent).toBe(false);
    expect(access.isAdultsEvent).not.toHaveBeenCalled();
    const stateQuery = queries.find((entry) =>
      entry.sql.includes('"open_session"'),
    );
    expect(stateQuery?.sql).toContain('"session"."quiz_id" = $1');
    expect(stateQuery?.parameters).toEqual([GAME_ID]);
  });
});
