import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';
import { setImageUrlBase } from '../common/image-url';
import { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import { quizshowCodeOf, quizshowError } from './quizshow-errors';
import { toQuizShape } from './quizshow-quiz-mapping';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { wheelSliceRoundIndexes } from './quizshow-wheel';
import type { QuizshowQuizInputDto } from './dto/quizshow-quiz-input.dto';
import type { QuizshowImportDto } from './dto/quizshow-import.dto';
import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowQuestionInput,
  type QuizshowQuiz,
  type QuizshowQuizShape,
  type QuizshowRoundInput,
} from './quizshow.contract';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const GAME_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_GAME_ID = '00000000-0000-4000-8000-0000000000b2';
const TEMPLATE_ID = '00000000-0000-4000-8000-0000000000c1';
const TEMPLATE_QUIZ_ID = '00000000-0000-4000-8000-0000000000c2';
const OTHER_TEMPLATE_ID = '00000000-0000-4000-8000-0000000000c3';
const EVENT_ID = 'event-1';
const SLUG = 'drag-bingo';
const STORED_UPDATED_AT = new Date('2026-10-19T10:00:00.000Z');
const OWN_IMAGE = `event-covers/${USER_ID}/00000000-0000-4000-8000-000000000001.jpg`;
const FOREIGN_IMAGE =
  'event-covers/00000000-0000-4000-8000-0000000000aa/00000000-0000-4000-8000-000000000002.jpg';
const EDITOR_USER_ID = 'user-editor';

/** The quiz columns v2 added, as a quiz with no open history stores them. */
const V2_QUIZ_COLUMNS = {
  lastOpenSettings: null,
  sourceTemplateCopiedAt: null,
} as const;

/** The question columns v2 added, as a save stores them on an MC question. */
const V2_QUESTION_COLUMNS = {
  mediaAltEn: '',
  mediaAltPt: '',
  mediaReveal: 'instant',
  revealNoteEn: '',
  revealNotePt: '',
  numberUnitEn: '',
  numberUnitPt: '',
} as const;

function multipleChoiceQuestion(
  overrides: Partial<QuizshowQuestionInput> = {},
): QuizshowQuestionInput {
  return {
    type: 'multiple_choice',
    prompt: { en: 'Which one?', pt: 'Qual?' },
    mediaRef: null,
    mediaAlt: { en: '', pt: '' },
    mediaReveal: 'instant',
    revealNote: { en: '', pt: '' },
    numberUnit: { en: '', pt: '' },
    timeLimitSeconds: null,
    points: 1000,
    options: [
      { id: 'a', text: { en: 'One', pt: 'Um' } },
      { id: 'b', text: { en: 'Two', pt: 'Dois' } },
    ],
    answer: { correctIndexes: [0] },
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
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
      isWarmUp: false,
      talkSeconds: 0,
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
): QuizshowQuizShape {
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
        is_practice: null,
        source_updated_at: null,
        has_results: false,
      },
    ] as object[],
    organisedEvent: [] as object[],
    importSources: [] as object[],
    gameSources: [] as object[],
    publishedTemplate: [] as object[],
    sourceTemplate: [] as object[],
    editorName: [] as object[],
  };
  // The data source and a transaction manager answer raw SQL alike.
  const query = jest.fn((sql: string, parameters: unknown[]) => {
    queries.push({ sql, parameters });
    if (sql.includes('"quiz"."source_template_id"')) {
      return Promise.resolve(queryResults.sourceTemplate);
    }
    if (sql.includes('"profiles"')) {
      return Promise.resolve(queryResults.editorName);
    }
    if (sql.includes('"quizshow_templates"')) {
      return Promise.resolve(queryResults.publishedTemplate);
    }
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
  });
  const manager = {
    query,
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
  const dataSource = {
    manager,
    transaction: jest.fn((callback: (entityManager: unknown) => unknown) =>
      Promise.resolve(callback(manager)),
    ),
    query,
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
    templateId: null,
    sourceTemplateId: null,
    createdByUserId: USER_ID,
    updatedByUserId: USER_ID,
    createdAt: STORED_UPDATED_AT,
    updatedAt: STORED_UPDATED_AT,
    ...V2_QUIZ_COLUMNS,
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
    answer: { correctIndexes: [0] },
    acceptedAnswers: [],
    timeLimitSeconds: null,
    points: 1000,
    ...V2_QUESTION_COLUMNS,
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
    templateId: null,
    sourceTemplateId: OTHER_TEMPLATE_ID,
    createdByUserId: game.ownerUserId,
    updatedByUserId: game.ownerUserId,
    createdAt: STORED_UPDATED_AT,
    updatedAt: STORED_UPDATED_AT,
    ...V2_QUIZ_COLUMNS,
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
    answer: { correctIndexes: [0] },
    acceptedAnswers: [],
    timeLimitSeconds: null,
    points: 1000,
    ...V2_QUESTION_COLUMNS,
  });
}

/** A staff template's quiz: one round with one question, owned by the template alone. */
function seedTemplateQuiz(
  store: FakeStore,
  contentLabel: QuizshowRoundInput['contentLabel'] = 'none',
): void {
  const roundId = 'template-round';
  store.quizzes.push({
    id: TEMPLATE_QUIZ_ID,
    eventId: null,
    ownerUserId: null,
    isAdultsOnly: false,
    title: 'Template quiz',
    languages: 'both',
    screenLanguage: 'en',
    templateId: TEMPLATE_ID,
    sourceTemplateId: null,
    createdByUserId: OTHER_USER_ID,
    updatedByUserId: OTHER_USER_ID,
    createdAt: STORED_UPDATED_AT,
    updatedAt: STORED_UPDATED_AT,
    ...V2_QUIZ_COLUMNS,
  });
  store.rounds.push({
    id: roundId,
    quizId: TEMPLATE_QUIZ_ID,
    position: 0,
    kind: 'quiz',
    titleEn: 'Template round',
    titlePt: 'Ronda do modelo',
    contentLabel,
    settings: round().settings,
  });
  store.questions.push({
    id: 'template-question',
    roundId,
    position: 0,
    type: 'multiple_choice',
    promptEn: 'Which year?',
    promptPt: 'Que ano?',
    mediaRef: null,
    options: multipleChoiceQuestion().options,
    answer: { correctIndexes: [1] },
    acceptedAnswers: [],
    timeLimitSeconds: 30,
    points: 500,
    ...V2_QUESTION_COLUMNS,
  });
}

interface SeededRow {
  kind: QuizshowRoundInput['kind'];
  title: string;
  questionCount: number;
  sliceCount?: number;
}

/** A source event quiz with the given rows; each quiz row holds `questionCount` MC questions. */
function seedSourceEventQuiz(store: FakeStore, rows: SeededRow[]): void {
  seedEventQuizRows(
    store,
    { quizId: 'source-quiz', eventId: 'source-event', title: 'Source quiz' },
    rows,
  );
}

/** An event quiz row with the given rows, stored as a save writes them. */
function seedEventQuizRows(
  store: FakeStore,
  quiz: { quizId: string; eventId: string; title: string },
  rows: SeededRow[],
): void {
  store.quizzes.push({
    id: quiz.quizId,
    eventId: quiz.eventId,
    ownerUserId: null,
    isAdultsOnly: false,
    title: quiz.title,
    languages: 'both',
    screenLanguage: 'en',
    templateId: null,
    sourceTemplateId: null,
    createdByUserId: USER_ID,
    updatedByUserId: USER_ID,
    createdAt: STORED_UPDATED_AT,
    updatedAt: STORED_UPDATED_AT,
    ...V2_QUIZ_COLUMNS,
  });
  rows.forEach((row, rowIndex) => {
    const roundId = `${quiz.quizId}-round-${rowIndex}`;
    store.rounds.push({
      id: roundId,
      quizId: quiz.quizId,
      position: rowIndex,
      kind: row.kind,
      titleEn: row.title,
      titlePt: row.title,
      contentLabel: 'none',
      settings: { ...round().settings, sliceCount: row.sliceCount ?? null },
    });
    for (
      let questionIndex = 0;
      questionIndex < row.questionCount;
      questionIndex += 1
    ) {
      store.questions.push({
        id: `${roundId}-question-${questionIndex}`,
        roundId,
        position: questionIndex,
        type: 'multiple_choice',
        promptEn: 'Which one?',
        promptPt: 'Qual?',
        mediaRef: null,
        options: multipleChoiceQuestion().options,
        answer: { correctIndexes: [0] },
        acceptedAnswers: [],
        timeLimitSeconds: null,
        points: 1000,
        ...V2_QUESTION_COLUMNS,
      });
    }
  });
}

function appendFromSourceEvent(
  overrides: Partial<QuizshowImportDto> = {},
): QuizshowImportDto {
  return {
    from: 'event',
    eventSlug: 'last-bingo',
    mode: 'append',
    roundIndexes: null,
    expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
    ...overrides,
  };
}

/** The stored rows of the event's own quiz, in position order. */
function targetRoundTitles(store: FakeStore): string[] {
  return store.rounds
    .filter((stored) => stored.quizId === 'quiz-1')
    .sort((first, second) => first.position - second.position)
    .map((stored) => stored.titleEn);
}

function roundsOf(quiz: QuizshowQuiz | null | undefined): unknown {
  return quiz ? toQuizShape(quiz).rounds : null;
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
        templateId: null,
        sourceTemplateId: null,
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: winner,
        updatedAt: winner,
        ...V2_QUIZ_COLUMNS,
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

  it("imports a published template with its id as source and copies an event quiz's source", async () => {
    const { service, store, queryResults, queries } = build();
    seedTemplateQuiz(store);
    queryResults.publishedTemplate = [{ quiz_id: TEMPLATE_QUIZ_ID }];

    const response = await service.importQuiz(SLUG, USER_ID, {
      from: 'template',
      templateId: TEMPLATE_ID,
    });

    expect(response.quiz?.sourceTemplateId).toBe(TEMPLATE_ID);
    const eventQuiz = store.quizzes.find((quiz) => quiz.eventId === EVENT_ID);
    expect(eventQuiz?.sourceTemplateId).toBe(TEMPLATE_ID);
    expect(eventQuiz?.templateId).toBeUndefined();
    expect(response.quiz?.title).toBe('Template quiz');
    const templateQuiz = await service.loadQuizById(TEMPLATE_QUIZ_ID);
    expect(templateQuiz?.rounds).toHaveLength(1);
    expect(roundsOf(response.quiz)).toEqual(roundsOf(templateQuiz));
    const templateQuery = queries.find((entry) =>
      entry.sql.includes('"quizshow_templates"'),
    );
    expect(templateQuery?.parameters).toEqual([TEMPLATE_ID]);

    const second = build();
    seedStoredQuiz(second.store, {
      eventId: 'source-event',
      sourceTemplateId: OTHER_TEMPLATE_ID,
    });
    second.queryResults.organisedEvent = [{ event_id: 'source-event' }];
    const eventResponse = await second.service.importQuiz(SLUG, USER_ID, {
      from: 'event',
      eventSlug: 'last-bingo',
    });

    expect(eventResponse.quiz?.sourceTemplateId).toBe(OTHER_TEMPLATE_ID);
    expect(eventResponse.quiz?.rounds).toHaveLength(1);
  });

  it('refuses a draft or unknown template with template not found and copies nothing', async () => {
    const { service, store, queryResults, queries, manager } = build();
    seedTemplateQuiz(store);
    queryResults.publishedTemplate = [];
    const quizzesBefore = structuredClone(store.quizzes);
    const roundsBefore = structuredClone(store.rounds);

    const error = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
      }),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_template_not_found');
    const templateQuery = queries.find((entry) =>
      entry.sql.includes('"quizshow_templates"'),
    );
    expect(templateQuery?.sql).toContain(
      '"template"."published_at" IS NOT NULL',
    );
    expect(templateQuery?.parameters).toEqual([TEMPLATE_ID]);
    expect(store.quizzes).toEqual(quizzesBefore);
    expect(store.rounds).toEqual(roundsBefore);
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();

    const missingId = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, {
        from: 'template',
      } as unknown as QuizshowImportDto),
    );
    expect(quizshowCodeOf(missingId)).toBe('quizshow_template_not_found');
    expect(store.quizzes).toEqual(quizzesBefore);
  });

  it('refuses an adults round from a template into a non-18+ event with the event code', async () => {
    const { service, store, queryResults } = build({ isAdultsEvent: false });
    seedTemplateQuiz(store, 'adults');
    queryResults.publishedTemplate = [{ quiz_id: TEMPLATE_QUIZ_ID }];

    const error = await codeOfRejection(
      service.importQuiz(SLUG, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
      }),
    );

    expect(quizshowCodeOf(error)).toBe(
      'quizshow_adults_round_needs_adults_event',
    );
    expect(store.quizzes.some((quiz) => quiz.eventId === EVENT_ID)).toBe(false);
  });

  it('keeps the stored source on an event save', async () => {
    const { service, store } = build();
    seedStoredQuiz(store, { sourceTemplateId: TEMPLATE_ID });

    const response = await service.replaceQuiz(
      SLUG,
      USER_ID,
      quizInput({ expectedUpdatedAt: STORED_UPDATED_AT.toISOString() }),
    );

    expect(store.quizzes).toHaveLength(1);
    expect(store.quizzes[0]?.sourceTemplateId).toBe(TEMPLATE_ID);
    expect(store.quizzes[0]?.title).toBe('Bingo night');
    expect(response.quiz?.sourceTemplateId).toBe(TEMPLATE_ID);
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
    expect(eventQuiz?.sourceTemplateId).toBe(OTHER_TEMPLATE_ID);
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
      rounds: [],
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
      sourceTemplateId: null,
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

  it('writes a template target by template id and allows an adults round', async () => {
    const { service, store, manager } = build({ isAdultsEvent: false });
    const shapeWithAdultsRound = gameShape([round({ contentLabel: 'adults' })]);

    expect(
      codeOfThrow(() =>
        service.assertShapeAllowed(
          { kind: 'template', templateId: TEMPLATE_ID },
          shapeWithAdultsRound,
        ),
      ),
    ).toBeNull();
    const tooFewOptions = multipleChoiceQuestion({
      options: [{ id: 'a', text: { en: 'One', pt: 'Um' } }],
    });
    expect(
      codeOfThrow(() =>
        service.assertShapeAllowed(
          { kind: 'template', templateId: TEMPLATE_ID },
          gameShape([round({}, [tooFewOptions])]),
        ),
      ),
    ).toBe('quizshow_quiz_invalid');

    const quizId = await service.writeQuiz({
      target: { kind: 'template', templateId: TEMPLATE_ID },
      userId: USER_ID,
      shape: shapeWithAdultsRound,
      sourceTemplateId: null,
      expectedUpdatedAt: undefined,
    });

    expect(quizId).toBe('quiz-new');
    expect(manager.findOne).toHaveBeenCalledWith(QuizshowQuizRecord, {
      where: { templateId: TEMPLATE_ID },
      lock: { mode: 'for_no_key_update' },
    });
    const insertedQuiz = store.quizzes.find((quiz) => quiz.id === quizId);
    expect(insertedQuiz).toMatchObject({
      templateId: TEMPLATE_ID,
      eventId: null,
      sourceTemplateId: null,
      title: 'Game night',
      createdByUserId: USER_ID,
    });
    expect(insertedQuiz).not.toHaveProperty('isAdultsOnly');
    expect(insertedQuiz).not.toHaveProperty('ownerUserId');
    expect(store.rounds.map((stored) => stored.contentLabel)).toEqual([
      'adults',
    ]);
  });

  it('answers game not found for a template quiz on the game builder', async () => {
    const { service, store } = build();
    seedTemplateQuiz(store);

    const error = await codeOfRejection(
      service.buildGameResponse(TEMPLATE_QUIZ_ID),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_game_not_found');
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
        sourceTemplateId: null,
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
        sourceTemplateId: null,
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
        is_practice: false,
        source_updated_at: STORED_UPDATED_AT.toISOString(),
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
      isPractice: false,
      isBehindQuiz: false,
    });
    expect(adultsResponse.lastOpenSettings).toBeNull();
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

  describe('live session, open settings and template line', () => {
    const OPEN_LOBBY = {
      session_id: 'session-1',
      join_code: 'ABC123',
      status: 'lobby',
      play_mode: 'solo',
      started_at: new Date('2026-10-20T19:00:00.000Z'),
      player_count: 2,
      is_practice: false,
      source_updated_at: STORED_UPDATED_AT.toISOString(),
      has_results: false,
    };

    it('reads a lobby built from an older save as behind and one built from this save as current', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store);
      queryResults.state = [
        { ...OPEN_LOBBY, source_updated_at: '2026-10-19T09:00:00.000Z' },
      ];

      const behind = await service.getQuiz(SLUG, USER_ID);
      expect(behind.liveSession?.isBehindQuiz).toBe(true);

      queryResults.state = [OPEN_LOBBY];
      const current = await service.getQuiz(SLUG, USER_ID);
      expect(current.liveSession?.isBehindQuiz).toBe(false);

      // A snapshot stored before v2 has no stamp, so its lobby is behind.
      queryResults.state = [{ ...OPEN_LOBBY, source_updated_at: null }];
      const legacy = await service.getQuiz(SLUG, USER_ID);
      expect(legacy.liveSession?.isBehindQuiz).toBe(true);
    });

    it('never reads a running session as behind', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store);
      queryResults.state = [
        {
          ...OPEN_LOBBY,
          status: 'running',
          source_updated_at: '2026-10-19T09:00:00.000Z',
        },
      ];

      const response = await service.getQuiz(SLUG, USER_ID);

      expect(response.liveSession?.status).toBe('running');
      expect(response.liveSession?.isBehindQuiz).toBe(false);
    });

    it('carries the practice flag of the open session', async () => {
      const { service, store, queryResults, queries } = build();
      seedStoredQuiz(store);
      queryResults.state = [{ ...OPEN_LOBBY, is_practice: true }];

      const response = await service.getQuiz(SLUG, USER_ID);

      expect(response.liveSession?.isPractice).toBe(true);
      const stateQuery = queries.find((entry) =>
        entry.sql.includes('"open_session"'),
      );
      expect(stateQuery?.sql).toContain('"session"."is_practice"');
      expect(stateQuery?.sql).toContain(
        `("session"."quiz_snapshot" ->> 'sourceUpdatedAt') AS "source_updated_at"`,
      );
    });

    it('returns the last open settings of the quiz, and null before any open', async () => {
      const { service, store } = build();
      seedStoredQuiz(store, {
        lastOpenSettings: {
          playMode: 'teams',
          maxTeamSize: 4,
          isReviewOn: false,
        },
      });

      const response = await service.getQuiz(SLUG, USER_ID);
      expect(response.lastOpenSettings).toEqual({
        playMode: 'teams',
        maxTeamSize: 4,
        isReviewOn: false,
      });

      const empty = build();
      const emptyResponse = await empty.service.getQuiz(SLUG, USER_ID);
      expect(emptyResponse.lastOpenSettings).toBeNull();
    });

    it('builds the template line with and without an update since the copy', async () => {
      const { service, store, queryResults, queries } = build();
      const copiedAt = new Date('2026-10-10T12:00:00.000Z');
      seedStoredQuiz(store, {
        sourceTemplateId: TEMPLATE_ID,
        sourceTemplateCopiedAt: copiedAt,
      });
      const templateRow = {
        template_id: TEMPLATE_ID,
        card_title_en: 'Pop divas',
        card_title_pt: 'Divas pop',
        content_updated_at: new Date('2026-10-15T12:00:00.000Z'),
        change_note_en: 'Two new rounds',
        change_note_pt: 'Duas rondas novas',
      };
      queryResults.sourceTemplate = [templateRow];

      const updated = await service.getQuiz(SLUG, USER_ID);
      expect(updated.quiz?.sourceTemplate).toEqual({
        templateId: TEMPLATE_ID,
        title: { en: 'Pop divas', pt: 'Divas pop' },
        copiedAt: copiedAt.toISOString(),
        lastPublishedAt: '2026-10-15T12:00:00.000Z',
        hasUpdate: true,
        changeNote: { en: 'Two new rounds', pt: 'Duas rondas novas' },
      });
      const templateQuery = queries.find((entry) =>
        entry.sql.includes('"quiz"."source_template_id"'),
      );
      expect(templateQuery?.sql).toContain(
        '"template"."published_at" IS NOT NULL',
      );
      expect(templateQuery?.parameters).toEqual(['quiz-1']);

      queryResults.sourceTemplate = [
        {
          ...templateRow,
          content_updated_at: new Date('2026-10-01T12:00:00.000Z'),
        },
      ];
      const current = await service.getQuiz(SLUG, USER_ID);
      expect(current.quiz?.sourceTemplate?.hasUpdate).toBe(false);
    });

    it('answers a null template line for an unpublished template and for a quiz with no copied stamp', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store, {
        sourceTemplateId: TEMPLATE_ID,
        sourceTemplateCopiedAt: new Date('2026-10-10T12:00:00.000Z'),
      });
      // The query keeps only published templates, so an unpublished one returns no row.
      queryResults.sourceTemplate = [];

      const unpublished = await service.getQuiz(SLUG, USER_ID);
      expect(unpublished.quiz?.sourceTemplate).toBeNull();

      const unstamped = build();
      seedStoredQuiz(unstamped.store, { sourceTemplateId: TEMPLATE_ID });
      const unstampedResponse = await unstamped.service.getQuiz(SLUG, USER_ID);
      expect(unstampedResponse.quiz?.sourceTemplate).toBeNull();
      expect(
        unstamped.queries.some((entry) =>
          entry.sql.includes('"quiz"."source_template_id"'),
        ),
      ).toBe(false);
    });
  });

  describe('save normalisation and conflict details', () => {
    it("saves screen language 'both' on an English-only quiz as 'en'", async () => {
      const { service, store } = build();

      const response = await service.replaceQuiz(
        SLUG,
        USER_ID,
        quizInput({ languages: 'en', screenLanguage: 'both' }),
      );

      expect(store.quizzes[0]?.screenLanguage).toBe('en');
      expect(response.quiz?.screenLanguage).toBe('en');
    });

    it('saves a question from a studio page cached before v2 and sorts the correct indexes', async () => {
      const { service, store } = build();
      const threeOptions = [
        { id: 'a', text: { en: 'One', pt: 'Um' } },
        { id: 'b', text: { en: 'Two', pt: 'Dois' } },
        { id: 'c', text: { en: 'Three', pt: 'Três' } },
      ];
      const legacyQuestion = {
        type: 'multiple_choice',
        prompt: { en: 'Which one?', pt: 'Qual?' },
        mediaRef: null,
        timeLimitSeconds: null,
        points: 1000,
        options: threeOptions,
        answer: { correctIndex: 1 },
        acceptedAnswers: [],
      } as unknown as QuizshowQuestionInput;
      const unsortedQuestion = multipleChoiceQuestion({
        options: threeOptions,
        answer: { correctIndexes: [2, 0] },
      });
      const legacySettings = { ...round().settings } as Record<string, unknown>;
      delete legacySettings.isWarmUp;
      delete legacySettings.talkSeconds;

      await service.replaceQuiz(
        SLUG,
        USER_ID,
        quizInput({
          rounds: [
            round(
              {
                settings:
                  legacySettings as unknown as QuizshowRoundInput['settings'],
              },
              [legacyQuestion, unsortedQuestion],
            ),
          ],
        }),
      );

      const savedAnswers = [...store.questions]
        .sort((first, second) => first.position - second.position)
        .map((stored) => stored.answer);
      expect(savedAnswers).toEqual([
        { correctIndexes: [1] },
        { correctIndexes: [0, 2] },
      ]);
      expect(store.questions[0]?.mediaReveal).toBe('instant');
      expect(store.questions[0]?.mediaAltEn).toBe('');
      expect(store.rounds[0]?.settings.isWarmUp).toBe(false);
      expect(store.rounds[0]?.settings.talkSeconds).toBe(0);
    });

    it('names the member who saved the stored quiz in the conflict, and null for a deleted account', async () => {
      const { service, store, queryResults, queries } = build();
      seedStoredQuiz(store, { updatedByUserId: EDITOR_USER_ID });
      queryResults.editorName = [{ first_name: 'Rui', last_name: 'Costa' }];

      const error = await codeOfRejection(
        service.replaceQuiz(
          SLUG,
          USER_ID,
          quizInput({ expectedUpdatedAt: '2026-10-19T09:00:00.000Z' }),
        ),
      );

      expect(quizshowCodeOf(error)).toBe('quizshow_quiz_changed');
      expect(bodyOf(error).updatedAt).toBe(STORED_UPDATED_AT.toISOString());
      expect(bodyOf(error).updatedByName).toBe('Rui Costa');
      const nameQuery = queries.find((entry) =>
        entry.sql.includes('"profiles"'),
      );
      expect(nameQuery?.parameters).toEqual([EDITOR_USER_ID]);

      const deleted = build();
      // The author column goes null when the account is deleted.
      seedStoredQuiz(deleted.store, { updatedByUserId: null });
      const deletedError = await codeOfRejection(
        deleted.service.replaceQuiz(
          SLUG,
          USER_ID,
          quizInput({ expectedUpdatedAt: '2026-10-19T09:00:00.000Z' }),
        ),
      );
      expect(bodyOf(deletedError).updatedByName).toBeNull();
    });
  });

  describe('import modes', () => {
    it('stamps the copy time on a replace from a template and carries the source stamp from an event', async () => {
      const { service, store, queryResults } = build();
      seedTemplateQuiz(store);
      queryResults.publishedTemplate = [{ quiz_id: TEMPLATE_QUIZ_ID }];

      await service.importQuiz(SLUG, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
      });

      const eventQuiz = store.quizzes.find((quiz) => quiz.eventId === EVENT_ID);
      expect(eventQuiz?.sourceTemplateCopiedAt).toBeInstanceOf(Date);

      const second = build();
      const sourceCopiedAt = new Date('2026-09-01T10:00:00.000Z');
      seedStoredQuiz(second.store, {
        eventId: 'source-event',
        sourceTemplateId: OTHER_TEMPLATE_ID,
        sourceTemplateCopiedAt: sourceCopiedAt,
      });
      second.queryResults.organisedEvent = [{ event_id: 'source-event' }];
      await second.service.importQuiz(SLUG, USER_ID, {
        from: 'event',
        eventSlug: 'last-bingo',
      });
      const copied = second.store.quizzes.find(
        (quiz) => quiz.eventId === EVENT_ID,
      );
      expect(copied?.sourceTemplateCopiedAt).toEqual(sourceCopiedAt);
    });

    it('appends the chosen rows after the stored ones and keeps the stored title and languages', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store);
      seedSourceEventQuiz(store, [
        { kind: 'quiz', title: 'Music', questionCount: 1 },
        { kind: 'quiz', title: 'Film', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      const response = await service.importQuiz(
        SLUG,
        USER_ID,
        appendFromSourceEvent({ roundIndexes: [1] }),
      );

      expect(targetRoundTitles(store)).toEqual(['Round', 'Film']);
      expect(response.quiz?.title).toBe('Stored');
    });

    it('refuses an append with a stale or missing token with the conflict details', async () => {
      const { service, store, queryResults, manager } = build();
      seedStoredQuiz(store);
      seedSourceEventQuiz(store, [
        { kind: 'quiz', title: 'Music', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      const stale = await codeOfRejection(
        service.importQuiz(
          SLUG,
          USER_ID,
          appendFromSourceEvent({
            expectedUpdatedAt: '2026-10-19T09:00:00.000Z',
          }),
        ),
      );
      expect(quizshowCodeOf(stale)).toBe('quizshow_quiz_changed');
      expect(bodyOf(stale).updatedAt).toBe(STORED_UPDATED_AT.toISOString());
      expect(bodyOf(stale)).toHaveProperty('updatedByName', null);

      const missing = await codeOfRejection(
        service.importQuiz(
          SLUG,
          USER_ID,
          appendFromSourceEvent({ expectedUpdatedAt: undefined }),
        ),
      );
      expect(quizshowCodeOf(missing)).toBe('quizshow_quiz_changed');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('keeps appended rows out of the target wheel whose range ends the quiz', async () => {
      const { service, store, queryResults } = build();
      seedEventQuizRows(
        store,
        { quizId: 'quiz-1', eventId: EVENT_ID, title: 'Stored' },
        [
          { kind: 'wheel', title: 'Spin', questionCount: 0 },
          { kind: 'quiz', title: 'Slice one', questionCount: 1 },
          { kind: 'quiz', title: 'Slice two', questionCount: 1 },
        ],
      );
      seedSourceEventQuiz(store, [
        { kind: 'wheel', title: 'Source spin', questionCount: 0 },
        { kind: 'quiz', title: 'Source slice', questionCount: 1 },
        { kind: 'quiz', title: 'Source slice two', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      // A slice row chosen without its own wheel.
      await service.importQuiz(
        SLUG,
        USER_ID,
        appendFromSourceEvent({ roundIndexes: [2] }),
      );

      expect(targetRoundTitles(store)).toEqual([
        'Spin',
        'Slice one',
        'Slice two',
        'Source slice two',
      ]);
      const targetRows = store.rounds
        .filter((stored) => stored.quizId === 'quiz-1')
        .sort((first, second) => first.position - second.position);
      expect(targetRows[0]?.settings.sliceCount).toBe(2);
      // The wheel helper reads rows that carry their questions; only kind and settings matter here.
      const targetWheelRows = targetRows.map((stored) => ({
        kind: stored.kind,
        settings: stored.settings,
        questions: [],
      }));
      expect(wheelSliceRoundIndexes(targetWheelRows, 0)).toEqual([1, 2]);
    });

    it('refuses an empty round choice and writes nothing', async () => {
      const { service, store, queryResults, manager } = build();
      seedStoredQuiz(store);
      seedSourceEventQuiz(store, [
        { kind: 'quiz', title: 'Music', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      const error = await codeOfRejection(
        service.importQuiz(
          SLUG,
          USER_ID,
          appendFromSourceEvent({ roundIndexes: [] }),
        ),
      );

      expect(quizshowCodeOf(error)).toBe('quizshow_import_round_not_found');
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('answers a null updatedAt when the append token names a quiz the target does not have', async () => {
      const { service, store, queryResults } = build();
      seedSourceEventQuiz(store, [
        { kind: 'quiz', title: 'Music', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      const error = await codeOfRejection(
        service.importQuiz(SLUG, USER_ID, appendFromSourceEvent()),
      );

      expect(quizshowCodeOf(error)).toBe('quizshow_quiz_changed');
      expect(bodyOf(error)).toHaveProperty('updatedAt', null);
      expect(bodyOf(error)).toHaveProperty('updatedByName', null);
    });

    it('refuses a round index the source does not hold', async () => {
      const { service, store, queryResults, manager } = build();
      seedStoredQuiz(store);
      seedSourceEventQuiz(store, [
        { kind: 'quiz', title: 'Music', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      const error = await codeOfRejection(
        service.importQuiz(
          SLUG,
          USER_ID,
          appendFromSourceEvent({ roundIndexes: [0, 3] }),
        ),
      );

      expect(quizshowCodeOf(error)).toBe('quizshow_import_round_not_found');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('brings the slice rows of a chosen wheel row', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store);
      seedSourceEventQuiz(store, [
        { kind: 'wheel', title: 'Spin', questionCount: 0, sliceCount: 2 },
        { kind: 'quiz', title: 'Slice one', questionCount: 1 },
        { kind: 'quiz', title: 'Slice two', questionCount: 1 },
        { kind: 'quiz', title: 'After the wheel', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      await service.importQuiz(
        SLUG,
        USER_ID,
        appendFromSourceEvent({ roundIndexes: [0] }),
      );

      expect(targetRoundTitles(store)).toEqual([
        'Round',
        'Spin',
        'Slice one',
        'Slice two',
      ]);
    });

    it('pins a chosen Auto wheel to the slices it brought, so a later chosen row stays a plain round', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store);
      seedSourceEventQuiz(store, [
        { kind: 'wheel', title: 'Spin', questionCount: 0 },
        { kind: 'quiz', title: 'Slice one', questionCount: 1 },
        { kind: 'quiz', title: 'Slice two', questionCount: 1 },
        { kind: 'wheel', title: 'Second spin', questionCount: 0 },
        { kind: 'quiz', title: 'Second slice', questionCount: 1 },
        { kind: 'quiz', title: 'Second slice two', questionCount: 1 },
      ]);
      queryResults.organisedEvent = [{ event_id: 'source-event' }];

      // The Auto wheel and a slice row of the second wheel, chosen without that wheel.
      await service.importQuiz(
        SLUG,
        USER_ID,
        appendFromSourceEvent({ roundIndexes: [0, 4] }),
      );

      expect(targetRoundTitles(store)).toEqual([
        'Round',
        'Spin',
        'Slice one',
        'Slice two',
        'Second slice',
      ]);
      const targetRows = store.rounds
        .filter((stored) => stored.quizId === 'quiz-1')
        .sort((first, second) => first.position - second.position);
      expect(targetRows[1]?.settings.sliceCount).toBe(2);
      // The wheel helper reads rows that carry their questions; only kind and settings matter here.
      const targetWheelRows = targetRows.map((stored) => ({
        kind: stored.kind,
        settings: stored.settings,
        questions: [],
      }));
      expect(wheelSliceRoundIndexes(targetWheelRows, 1)).toEqual([2, 3]);
    });

    it.each([
      [
        'quizshow_import_too_many_rounds',
        Array.from({ length: 10 }, (_row, rowIndex) => ({
          kind: 'quiz' as const,
          title: `Round ${rowIndex}`,
          questionCount: 1,
        })),
      ],
      [
        'quizshow_import_too_many_questions',
        Array.from({ length: 5 }, (_row, rowIndex) => ({
          kind: 'quiz' as const,
          title: `Round ${rowIndex}`,
          questionCount: 20,
        })),
      ],
      [
        'quizshow_import_too_many_wheels',
        Array.from({ length: 4 }, (_row, rowIndex) => ({
          kind: 'wheel' as const,
          title: `Wheel ${rowIndex}`,
          questionCount: 0,
        })),
      ],
    ])(
      'refuses an append over a limit with %s',
      async (expectedCode, sourceRows) => {
        const { service, store, queryResults, manager } = build();
        seedStoredQuiz(store);
        seedSourceEventQuiz(store, sourceRows);
        queryResults.organisedEvent = [{ event_id: 'source-event' }];

        const error = await codeOfRejection(
          service.importQuiz(SLUG, USER_ID, appendFromSourceEvent()),
        );

        expect(quizshowCodeOf(error)).toBe(expectedCode);
        expect(manager.update).not.toHaveBeenCalled();
      },
    );

    it('sets the source template and its stamp on a template append into a quiz with no source', async () => {
      const { service, store, queryResults } = build();
      seedStoredQuiz(store);
      seedTemplateQuiz(store);
      queryResults.publishedTemplate = [{ quiz_id: TEMPLATE_QUIZ_ID }];

      await service.importQuiz(SLUG, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
        mode: 'append',
        roundIndexes: null,
        expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
      });

      const eventQuiz = store.quizzes.find((quiz) => quiz.eventId === EVENT_ID);
      expect(eventQuiz?.sourceTemplateId).toBe(TEMPLATE_ID);
      expect(eventQuiz?.sourceTemplateCopiedAt).toBeInstanceOf(Date);
      expect(eventQuiz?.title).toBe('Stored');
      expect(targetRoundTitles(store)).toEqual(['Round', 'Template round']);
    });

    it('keeps the stored source and stamp on a template append into a quiz that has one', async () => {
      const { service, store, queryResults } = build();
      const storedCopiedAt = new Date('2026-09-01T10:00:00.000Z');
      seedStoredQuiz(store, {
        sourceTemplateId: OTHER_TEMPLATE_ID,
        sourceTemplateCopiedAt: storedCopiedAt,
      });
      seedTemplateQuiz(store);
      queryResults.publishedTemplate = [{ quiz_id: TEMPLATE_QUIZ_ID }];

      await service.importQuiz(SLUG, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
        mode: 'append',
        roundIndexes: null,
        expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
      });

      const eventQuiz = store.quizzes.find((quiz) => quiz.eventId === EVENT_ID);
      expect(eventQuiz?.sourceTemplateId).toBe(OTHER_TEMPLATE_ID);
      expect(eventQuiz?.sourceTemplateCopiedAt).toEqual(storedCopiedAt);
    });

    it("refreshes the copy stamp on a template append from the quiz's own template", async () => {
      const { service, store, queryResults } = build();
      const storedCopiedAt = new Date('2026-09-01T10:00:00.000Z');
      seedStoredQuiz(store, {
        sourceTemplateId: TEMPLATE_ID,
        sourceTemplateCopiedAt: storedCopiedAt,
      });
      seedTemplateQuiz(store);
      queryResults.publishedTemplate = [{ quiz_id: TEMPLATE_QUIZ_ID }];

      await service.importQuiz(SLUG, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
        mode: 'append',
        roundIndexes: null,
        expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
      });

      const eventQuiz = store.quizzes.find((quiz) => quiz.eventId === EVENT_ID);
      expect(eventQuiz?.sourceTemplateId).toBe(TEMPLATE_ID);
      expect(eventQuiz?.sourceTemplateCopiedAt).toBeInstanceOf(Date);
      expect(eventQuiz?.sourceTemplateCopiedAt?.getTime()).toBeGreaterThan(
        storedCopiedAt.getTime(),
      );
    });
  });
});
