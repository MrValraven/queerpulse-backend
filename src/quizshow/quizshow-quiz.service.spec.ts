import { QueryFailedError, type DataSource } from 'typeorm';
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
} from './quizshow.contract';

const USER_ID = 'user-1';
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
          store.quizzes.find((quiz) => quiz.eventId === where.eventId) ?? null,
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
});
