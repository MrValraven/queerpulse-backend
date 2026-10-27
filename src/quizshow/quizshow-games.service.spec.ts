import type { DataSource } from 'typeorm';
import type { ModAuditService } from '../moderation/mod-audit.service';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import type { QuizshowAccessService } from './quizshow-access.service';
import { quizshowCodeOf, quizshowError } from './quizshow-errors';
import {
  GAME_LIST_SQL,
  QUIZSHOW_AUDIT_ACTIONS,
  QuizshowGamesService,
  SESSION_GAME_SQL,
  SESSION_REPORT_SQL,
} from './quizshow-games.service';
import { QuizshowQuizService } from './quizshow-quiz.service';
import type { QuizshowRuntimeService } from './quizshow-runtime.service';
import type {
  QuizshowCreateGameDto,
  QuizshowGameInputDto,
} from './dto/quizshow-game.dto';
import type { QuizshowImportDto } from './dto/quizshow-import.dto';
import type {
  QuizshowGameResponse,
  QuizshowImportSource,
  QuizshowQuestionInput,
  QuizshowQuiz,
  QuizshowRoundInput,
  QuizshowQuizShape,
} from './quizshow.contract';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const GAME_ID = '00000000-0000-4000-8000-0000000000b1';
const NEW_GAME_ID = '00000000-0000-4000-8000-0000000000b9';
const SESSION_ID = '00000000-0000-4000-8000-0000000000c1';
const STAFF_ID = '00000000-0000-4000-8000-0000000000d1';
const REPORT_ID = '00000000-0000-4000-8000-0000000000e1';
const TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-000000000003';
const STORED_UPDATED_AT = '2026-10-19T10:00:00.000Z';
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

function sourceShape(
  rounds: QuizshowRoundInput[] = [round()],
  title = 'Source quiz',
): QuizshowQuizShape {
  return { title, languages: 'pt', screenLanguage: 'pt', rounds };
}

function gameInput(
  overrides: Partial<QuizshowGameInputDto> = {},
): QuizshowGameInputDto {
  return {
    expectedUpdatedAt: STORED_UPDATED_AT,
    title: 'Friday quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds: [round()],
    isAdultsOnly: false,
    ...overrides,
  } as unknown as QuizshowGameInputDto;
}

/** A stored quiz with ids and image urls, as `loadQuizById` returns it. */
function storedQuiz(
  rounds: QuizshowRoundInput[] = [round()],
  mediaRef: string | null = null,
): QuizshowQuiz {
  return {
    title: 'Friday quiz',
    languages: 'both',
    screenLanguage: 'en',
    sourceTemplateId: TEMPLATE_ID,
    updatedAt: STORED_UPDATED_AT,
    rounds: rounds.map((storedRound, roundIndex) => ({
      ...storedRound,
      id: `round-${roundIndex}`,
      questions: storedRound.questions.map((question, questionIndex) => ({
        ...question,
        mediaRef: mediaRef ?? question.mediaRef,
        id: `question-${roundIndex}-${questionIndex}`,
        mediaUrl: null,
      })),
    })),
  };
}

interface StoredGame {
  id: string;
  ownerUserId: string;
  title: string;
  isAdultsOnly: boolean;
}

function build(
  options: {
    games?: StoredGame[];
    gameCount?: number;
    sessionGameRows?: { game_id: string; owner_user_id: string }[];
    /** What the report lookup answers; empty means no game report about this session. */
    reportRows?: { id: string }[];
  } = {},
) {
  const games: StoredGame[] = options.games ?? [
    {
      id: GAME_ID,
      ownerUserId: USER_ID,
      title: 'Friday quiz',
      isAdultsOnly: false,
    },
  ];
  const callOrder: string[] = [];
  const access = {
    // Mirrors Task 12: a game the caller owns, else game not found.
    loadOwnedGame: jest.fn((gameId: string, userId: string) => {
      const ownedGame = games.find(
        (game) => game.id === gameId && game.ownerUserId === userId,
      );
      return ownedGame
        ? Promise.resolve(ownedGame as unknown as QuizshowQuizRecord)
        : Promise.reject(quizshowError('quizshow_game_not_found'));
    }),
  };
  const runtime = {
    abandonSessionsOfGames: jest.fn(() => {
      callOrder.push('abandon');
      return Promise.resolve();
    }),
  };
  const transactionManager = {
    query: jest.fn((sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        callOrder.push('lock');
        return Promise.resolve([{ pg_advisory_xact_lock: '' }]);
      }
      callOrder.push('count');
      return Promise.resolve([{ game_count: options.gameCount ?? 0 }]);
    }),
    insert: jest.fn(),
    delete: jest.fn(() => {
      callOrder.push('delete');
      return Promise.resolve({ affected: 1 });
    }),
  };
  const dataSource = {
    query: jest.fn((sql: string): Promise<unknown[]> => {
      if (sql === SESSION_GAME_SQL) {
        return Promise.resolve(options.sessionGameRows ?? []);
      }
      if (sql === SESSION_REPORT_SQL) {
        callOrder.push('report');
        return Promise.resolve(options.reportRows ?? []);
      }
      return Promise.resolve([]);
    }),
    transaction: jest.fn(
      (work: (manager: typeof transactionManager) => Promise<unknown>) =>
        work(transactionManager),
    ),
    manager: {
      delete: jest.fn(() => {
        callOrder.push('delete');
        return Promise.resolve({ affected: 1 });
      }),
    },
  };
  // The real quiz service keeps the structural and 18+ checks; its reads and writes are stubbed.
  const quizzes = new QuizshowQuizService(
    dataSource as unknown as DataSource,
    {} as unknown as QuizshowAccessService,
  );
  const gameResponse = (gameId: string): QuizshowGameResponse => ({
    gameId,
    isAdultsOnly: false,
    quiz: null,
    problems: [],
    isAdultsEvent: false,
    liveSession: null,
    hasResults: false,
  });
  const writeQuiz = jest.spyOn(quizzes, 'writeQuiz').mockImplementation(() => {
    callOrder.push('write');
    return Promise.resolve(NEW_GAME_ID);
  });
  const resolveImportShape = jest
    .spyOn(quizzes, 'resolveImportShape')
    .mockResolvedValue({ shape: sourceShape(), sourceTemplateId: null });
  const loadQuizById = jest
    .spyOn(quizzes, 'loadQuizById')
    .mockResolvedValue(storedQuiz());
  const buildGameResponse = jest
    .spyOn(quizzes, 'buildGameResponse')
    .mockImplementation((gameId: string) =>
      Promise.resolve(gameResponse(gameId)),
    );
  const listGameImportSources = jest
    .spyOn(quizzes, 'listGameImportSources')
    .mockResolvedValue([]);
  const modAudit = {
    writeAuditLog: jest.fn(() => {
      callOrder.push('audit');
      return Promise.resolve('audit-1');
    }),
  };
  const service = new QuizshowGamesService(
    dataSource as unknown as DataSource,
    access as unknown as QuizshowAccessService,
    quizzes,
    runtime as unknown as QuizshowRuntimeService,
    modAudit as unknown as ModAuditService,
  );
  return {
    service,
    access,
    runtime,
    modAudit,
    dataSource,
    transactionManager,
    callOrder,
    writeQuiz,
    resolveImportShape,
    loadQuizById,
    buildGameResponse,
    listGameImportSources,
  };
}

function createInput(
  title: string,
  source: QuizshowImportDto | null,
): QuizshowCreateGameDto {
  return { title, source };
}

async function caughtError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to be refused');
}

describe('QuizshowGamesService', () => {
  it("lists only the caller's games, newest first, with counts, the live session and kept results", async () => {
    const { service, dataSource } = build();
    dataSource.query.mockResolvedValueOnce([
      {
        id: GAME_ID,
        title: 'Friday quiz',
        is_adults_only: true,
        updated_at: new Date('2026-10-20T09:00:00.000Z'),
        round_count: 3,
        question_count: 24,
        session_id: SESSION_ID,
        join_code: 'ABCD12',
        status: 'lobby',
        play_mode: 'teams',
        started_at: new Date('2026-10-20T08:30:00.000Z'),
        player_count: 7,
        has_results: false,
      },
      {
        id: NEW_GAME_ID,
        title: 'Older quiz',
        is_adults_only: false,
        updated_at: '2026-10-18T09:00:00.000Z',
        round_count: 0,
        question_count: 0,
        session_id: null,
        join_code: null,
        status: null,
        play_mode: null,
        started_at: null,
        player_count: null,
        has_results: true,
      },
    ]);

    const response = await service.listGames(USER_ID);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = dataSource.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toBe(GAME_LIST_SQL);
    expect(sql).toContain('WHERE "quiz"."owner_user_id" = $1');
    expect(sql).toContain('ORDER BY "quiz"."updated_at" DESC, "quiz"."id"');
    expect(sql).toContain('"kept_session"."results_kept" = true');
    expect(sql).toContain("IN ('lobby', 'running', 'paused')");
    expect(parameters[0]).toBe(USER_ID);
    expect(response.limit).toBe(50);
    expect(response.games).toEqual([
      {
        id: GAME_ID,
        title: 'Friday quiz',
        roundCount: 3,
        questionCount: 24,
        isAdultsOnly: true,
        liveSession: {
          sessionId: SESSION_ID,
          joinCode: 'ABCD12',
          status: 'lobby',
          playMode: 'teams',
          playerCount: 7,
          startedAt: '2026-10-20T08:30:00.000Z',
        },
        hasResults: false,
        updatedAt: '2026-10-20T09:00:00.000Z',
      },
      {
        id: NEW_GAME_ID,
        title: 'Older quiz',
        roundCount: 0,
        questionCount: 0,
        isAdultsOnly: false,
        liveSession: null,
        hasResults: true,
        updatedAt: '2026-10-18T09:00:00.000Z',
      },
    ]);
  });

  it('creates a blank game with the trimmed title, both languages and the switch off', async () => {
    const { service, writeQuiz, transactionManager, resolveImportShape } =
      build();

    const response = await service.createGame(
      USER_ID,
      createInput('  Friday quiz  ', null),
    );

    expect(resolveImportShape).not.toHaveBeenCalled();
    expect(writeQuiz).toHaveBeenCalledTimes(1);
    expect(writeQuiz).toHaveBeenCalledWith(
      {
        target: { kind: 'new_game', ownerUserId: USER_ID, isAdultsOnly: false },
        userId: USER_ID,
        shape: {
          title: 'Friday quiz',
          languages: 'both',
          screenLanguage: 'en',
          rounds: [],
        },
        sourceTemplateId: null,
        expectedUpdatedAt: undefined,
      },
      transactionManager,
    );
    expect(response.gameId).toBe(NEW_GAME_ID);
  });

  it('creates a game from a published template with the template as source and the switch on for an adults round', async () => {
    const { service, writeQuiz, resolveImportShape } = build();
    const adultsShape = sourceShape([
      round(),
      round({ contentLabel: 'adults' }),
    ]);
    resolveImportShape.mockResolvedValueOnce({
      shape: adultsShape,
      sourceTemplateId: TEMPLATE_ID,
    });
    const source = {
      from: 'template',
      templateId: TEMPLATE_ID,
    } as QuizshowImportDto;

    await service.createGame(USER_ID, createInput('Late night', source));

    expect(resolveImportShape).toHaveBeenCalledWith(source, USER_ID, {
      eventSlug: null,
      gameId: null,
    });
    expect(writeQuiz.mock.calls[0]?.[0]).toEqual({
      target: { kind: 'new_game', ownerUserId: USER_ID, isAdultsOnly: true },
      userId: USER_ID,
      shape: { ...adultsShape, title: 'Late night' },
      sourceTemplateId: TEMPLATE_ID,
      expectedUpdatedAt: undefined,
    });

    resolveImportShape.mockResolvedValueOnce({
      shape: sourceShape([round()]),
      sourceTemplateId: null,
    });
    await service.createGame(USER_ID, createInput('Early night', source));
    expect(writeQuiz.mock.calls[1]?.[0].target).toEqual({
      kind: 'new_game',
      ownerUserId: USER_ID,
      isAdultsOnly: false,
    });
  });

  it('refuses the 51st game on create and on duplicate with game limit reached', async () => {
    const { service, writeQuiz, buildGameResponse } = build({
      gameCount: 50,
    });

    const createError = await caughtError(
      service.createGame(USER_ID, createInput('One more', null)),
    );
    const duplicateError = await caughtError(
      service.duplicateGame(GAME_ID, USER_ID),
    );

    expect(quizshowCodeOf(createError)).toBe('quizshow_game_limit_reached');
    expect(quizshowCodeOf(duplicateError)).toBe('quizshow_game_limit_reached');
    expect(writeQuiz).not.toHaveBeenCalled();
    expect(buildGameResponse).not.toHaveBeenCalled();
  });

  it('takes the per-member lock before counting games', async () => {
    const { service, transactionManager, callOrder } = build({
      gameCount: 49,
    });

    await service.createGame(USER_ID, createInput('Friday quiz', null));

    const [lockSql, lockParameters] = transactionManager.query.mock
      .calls[0] as unknown as [string, unknown[]];
    expect(lockSql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(lockParameters).toEqual(['quizshow_games:' + USER_ID]);
    const [countSql, countParameters] = transactionManager.query.mock
      .calls[1] as unknown as [string, unknown[]];
    expect(countSql).toContain('COUNT(*)');
    expect(countSql).toContain('"quiz"."owner_user_id" = $1');
    expect(countParameters).toEqual([USER_ID]);
    expect(callOrder).toEqual(['lock', 'count', 'write']);
  });

  it('duplicates a game with the same title, switch and rounds, without sessions or results', async () => {
    const adultsRounds = [round(), round({ contentLabel: 'adults' })];
    const {
      service,
      writeQuiz,
      loadQuizById,
      transactionManager,
      dataSource,
      runtime,
    } = build({
      games: [
        {
          id: GAME_ID,
          ownerUserId: USER_ID,
          title: 'Friday quiz',
          isAdultsOnly: true,
        },
      ],
    });
    loadQuizById.mockResolvedValueOnce(storedQuiz(adultsRounds));

    const response = await service.duplicateGame(GAME_ID, USER_ID);

    expect(loadQuizById).toHaveBeenCalledWith(GAME_ID);
    expect(writeQuiz).toHaveBeenCalledTimes(1);
    expect(writeQuiz).toHaveBeenCalledWith(
      {
        target: { kind: 'new_game', ownerUserId: USER_ID, isAdultsOnly: true },
        userId: USER_ID,
        shape: {
          title: 'Friday quiz',
          languages: 'both',
          screenLanguage: 'en',
          rounds: adultsRounds,
        },
        sourceTemplateId: TEMPLATE_ID,
        expectedUpdatedAt: undefined,
      },
      transactionManager,
    );
    // Only the lock and the count run in the transaction; no session or result row is read or copied.
    expect(transactionManager.query).toHaveBeenCalledTimes(2);
    expect(transactionManager.insert).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(runtime.abandonSessionsOfGames).not.toHaveBeenCalled();
    expect(response.gameId).toBe(NEW_GAME_ID);
  });

  it('refuses turning the switch off while the game keeps an adults round', async () => {
    const { service, writeQuiz } = build({
      games: [
        {
          id: GAME_ID,
          ownerUserId: USER_ID,
          title: 'Friday quiz',
          isAdultsOnly: true,
        },
      ],
    });

    const error = await caughtError(
      service.replaceGame(
        GAME_ID,
        USER_ID,
        gameInput({
          isAdultsOnly: false,
          rounds: [round({ contentLabel: 'adults' })],
        }),
      ),
    );

    expect(quizshowCodeOf(error)).toBe(
      'quizshow_game_adults_rounds_need_switch',
    );
    expect(writeQuiz).not.toHaveBeenCalled();
  });

  it('refuses a game save that breaks the quiz limits before writing', async () => {
    const { service, writeQuiz } = build();
    const elevenRounds = Array.from({ length: 11 }, () => round());

    const error = await caughtError(
      service.replaceGame(
        GAME_ID,
        USER_ID,
        gameInput({ rounds: elevenRounds }),
      ),
    );

    expect(quizshowCodeOf(error)).toBe('quizshow_quiz_invalid');
    expect(writeQuiz).not.toHaveBeenCalled();
  });

  it('keeps the source template on a game save and a duplicate', async () => {
    const { service, writeQuiz, buildGameResponse } = build();
    const input = gameInput({
      isAdultsOnly: true,
      rounds: [round({ contentLabel: 'adults' })],
    });

    await service.replaceGame(GAME_ID, USER_ID, input);

    expect(writeQuiz).toHaveBeenCalledWith({
      target: { kind: 'game', gameId: GAME_ID, isAdultsOnly: true },
      userId: USER_ID,
      shape: input,
      sourceTemplateId: TEMPLATE_ID,
      expectedUpdatedAt: STORED_UPDATED_AT,
    });
    expect(buildGameResponse).toHaveBeenCalledWith(GAME_ID);

    await service.duplicateGame(GAME_ID, USER_ID);

    expect(writeQuiz.mock.calls[1]?.[0].sourceTemplateId).toBe(TEMPLATE_ID);
  });

  it('refuses a template with an adults round into a game whose switch is off with the game code', async () => {
    const { service, writeQuiz, resolveImportShape } = build();
    resolveImportShape.mockResolvedValueOnce({
      shape: sourceShape([round({ contentLabel: 'adults' })]),
      sourceTemplateId: TEMPLATE_ID,
    });

    const error = await caughtError(
      service.importIntoGame(GAME_ID, USER_ID, {
        from: 'template',
        templateId: TEMPLATE_ID,
      }),
    );

    expect(quizshowCodeOf(error)).toBe(
      'quizshow_game_adults_rounds_need_switch',
    );
    expect(writeQuiz).not.toHaveBeenCalled();
  });

  it('imports a template into a game and keeps the game title and switch', async () => {
    const { service, writeQuiz, resolveImportShape, buildGameResponse } = build(
      {
        games: [
          {
            id: GAME_ID,
            ownerUserId: USER_ID,
            title: 'My Friday quiz',
            isAdultsOnly: true,
          },
        ],
      },
    );
    const importedShape = sourceShape(
      [round({ contentLabel: 'adults' })],
      'Template title',
    );
    resolveImportShape.mockResolvedValueOnce({
      shape: importedShape,
      sourceTemplateId: TEMPLATE_ID,
    });
    const input = {
      from: 'template',
      templateId: TEMPLATE_ID,
    } as QuizshowImportDto;

    await service.importIntoGame(GAME_ID, USER_ID, input);

    expect(resolveImportShape).toHaveBeenCalledWith(input, USER_ID, {
      eventSlug: null,
      gameId: GAME_ID,
    });
    expect(writeQuiz).toHaveBeenCalledWith({
      target: { kind: 'game', gameId: GAME_ID, isAdultsOnly: true },
      userId: USER_ID,
      shape: {
        title: 'My Friday quiz',
        languages: 'pt',
        screenLanguage: 'pt',
        rounds: importedShape.rounds,
      },
      sourceTemplateId: TEMPLATE_ID,
      expectedUpdatedAt: undefined,
    });
    expect(buildGameResponse).toHaveBeenCalledWith(GAME_ID);
  });

  it('refuses a foreign upload the game does not already hold', async () => {
    const { service, writeQuiz, loadQuizById } = build();
    const withForeignImage = gameInput({
      rounds: [
        round({}, [multipleChoiceQuestion({ mediaRef: FOREIGN_IMAGE })]),
      ],
    });

    await expect(
      service.replaceGame(GAME_ID, USER_ID, withForeignImage),
    ).rejects.toThrow('Referenced upload does not belong to you');
    expect(writeQuiz).not.toHaveBeenCalled();

    loadQuizById.mockResolvedValueOnce(storedQuiz([round()], FOREIGN_IMAGE));
    await service.replaceGame(GAME_ID, USER_ID, withForeignImage);
    expect(writeQuiz).toHaveBeenCalledTimes(1);
  });

  it('answers game not found to a member who does not own the game on every route', async () => {
    const {
      service,
      writeQuiz,
      runtime,
      dataSource,
      buildGameResponse,
      listGameImportSources,
      resolveImportShape,
    } = build();
    const routes: (() => Promise<unknown>)[] = [
      () => service.getGame(GAME_ID, OTHER_USER_ID),
      () => service.replaceGame(GAME_ID, OTHER_USER_ID, gameInput()),
      () => service.deleteGame(GAME_ID, OTHER_USER_ID),
      () => service.duplicateGame(GAME_ID, OTHER_USER_ID),
      () =>
        service.importIntoGame(GAME_ID, OTHER_USER_ID, {
          from: 'template',
          templateId: TEMPLATE_ID,
        }),
      () => service.listImportSources(GAME_ID, OTHER_USER_ID),
    ];

    for (const callRoute of routes) {
      expect(quizshowCodeOf(await caughtError(callRoute()))).toBe(
        'quizshow_game_not_found',
      );
    }
    expect(writeQuiz).not.toHaveBeenCalled();
    expect(resolveImportShape).not.toHaveBeenCalled();
    expect(buildGameResponse).not.toHaveBeenCalled();
    expect(listGameImportSources).not.toHaveBeenCalled();
    expect(runtime.abandonSessionsOfGames).not.toHaveBeenCalled();
    expect(dataSource.manager.delete).not.toHaveBeenCalled();
  });

  it('ends the open session as abandoned before deleting a game', async () => {
    const { service, runtime, dataSource, callOrder } = build();

    await service.deleteGame(GAME_ID, USER_ID);

    expect(callOrder).toEqual(['abandon', 'delete']);
    expect(runtime.abandonSessionsOfGames).toHaveBeenCalledWith(
      [GAME_ID],
      expect.any(Number),
    );
    expect(dataSource.manager.delete).toHaveBeenCalledWith(QuizshowQuizRecord, {
      id: GAME_ID,
      ownerUserId: USER_ID,
    });
  });

  it('lists other games and organised events as import sources', async () => {
    const { service, listGameImportSources } = build();
    const sources: QuizshowImportSource[] = [
      {
        kind: 'event',
        eventSlug: 'drag-bingo',
        eventTitle: 'Drag bingo',
        startAt: '2026-10-01T20:00:00.000Z',
        gameId: null,
        quizTitle: 'Bingo night',
        roundCount: 2,
        questionCount: 12,
        hasAdultsRounds: false,
        isSameSeries: false,
      },
      {
        kind: 'game',
        eventSlug: null,
        eventTitle: null,
        startAt: null,
        gameId: NEW_GAME_ID,
        quizTitle: 'Older quiz',
        roundCount: 1,
        questionCount: 5,
        hasAdultsRounds: true,
        isSameSeries: false,
      },
    ];
    listGameImportSources.mockResolvedValueOnce(sources);

    const items = await service.listImportSources(GAME_ID, USER_ID);

    expect(listGameImportSources).toHaveBeenCalledWith(GAME_ID, USER_ID);
    expect(items).toEqual(sources);
  });

  it('ends the open session of a reported game for staff and deletes the game', async () => {
    const { service, runtime, dataSource, transactionManager, callOrder } =
      build({
        sessionGameRows: [{ game_id: GAME_ID, owner_user_id: USER_ID }],
      });

    await service.endGameSessionAsStaff(STAFF_ID, SESSION_ID, {
      reason: 'Hateful questions',
    });

    expect(dataSource.query).toHaveBeenCalledWith(SESSION_GAME_SQL, [
      SESSION_ID,
    ]);
    expect(SESSION_GAME_SQL).toContain('"quiz"."owner_user_id" IS NOT NULL');
    expect(SESSION_GAME_SQL).toContain(
      '"quiz"."owner_user_id" AS "owner_user_id"',
    );
    expect(runtime.abandonSessionsOfGames).toHaveBeenCalledWith(
      [GAME_ID],
      expect.any(Number),
    );
    expect(dataSource.manager.delete).not.toHaveBeenCalled();
    expect(transactionManager.delete).not.toHaveBeenCalled();

    callOrder.length = 0;
    await service.deleteGameAsStaff(STAFF_ID, SESSION_ID, {
      reason: 'Hateful questions',
    });

    expect(callOrder).toEqual(['abandon', 'delete', 'audit']);
    expect(transactionManager.delete).toHaveBeenCalledWith(QuizshowQuizRecord, {
      id: GAME_ID,
    });
    expect(dataSource.manager.delete).not.toHaveBeenCalled();
  });

  it('writes an audit row when staff end a reported game', async () => {
    const { service, modAudit, dataSource, callOrder } = build({
      sessionGameRows: [{ game_id: GAME_ID, owner_user_id: USER_ID }],
      reportRows: [{ id: REPORT_ID }],
    });

    await service.endGameSessionAsStaff(STAFF_ID, SESSION_ID, {
      reason: 'Outing a member',
      reportId: REPORT_ID,
    });

    expect(dataSource.query).toHaveBeenCalledWith(SESSION_REPORT_SQL, [
      REPORT_ID,
      SESSION_ID,
    ]);
    expect(SESSION_REPORT_SQL).toContain(
      `"report"."subject_type" = 'quizshow_game'`,
    );
    expect(SESSION_REPORT_SQL).toContain(
      'lower("report"."subject_id") = lower($2)',
    );
    expect(callOrder).toEqual(['report', 'abandon', 'audit']);
    expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      REPORT_ID,
      STAFF_ID,
      'quizshow_game_ended',
      undefined,
      `${SESSION_ID}: Outing a member`,
      undefined,
      undefined,
      USER_ID,
    );
    expect(QUIZSHOW_AUDIT_ACTIONS.gameEnded).toBe('quizshow_game_ended');
  });

  it('writes an audit row when staff delete a reported game', async () => {
    const { service, modAudit, transactionManager, dataSource, callOrder } =
      build({
        sessionGameRows: [{ game_id: GAME_ID, owner_user_id: USER_ID }],
        reportRows: [{ id: REPORT_ID }],
      });

    await service.deleteGameAsStaff(STAFF_ID, SESSION_ID, {
      reason: 'Explicit content with no label',
      reportId: REPORT_ID,
    });

    expect(callOrder).toEqual(['report', 'abandon', 'delete', 'audit']);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    // The audit row is written through the delete's transaction manager.
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      REPORT_ID,
      STAFF_ID,
      'quizshow_game_deleted',
      undefined,
      `${SESSION_ID}: Explicit content with no label`,
      undefined,
      transactionManager,
      USER_ID,
    );
    expect(QUIZSHOW_AUDIT_ACTIONS.gameDeleted).toBe('quizshow_game_deleted');
  });

  it("refuses a reportId that is not this game's report", async () => {
    const { service, modAudit, runtime, transactionManager, dataSource } =
      build({
        sessionGameRows: [{ game_id: GAME_ID, owner_user_id: USER_ID }],
        reportRows: [],
      });

    const endError = await caughtError(
      service.endGameSessionAsStaff(STAFF_ID, SESSION_ID, {
        reason: 'Spam',
        reportId: REPORT_ID,
      }),
    );
    const deleteError = await caughtError(
      service.deleteGameAsStaff(STAFF_ID, SESSION_ID, {
        reason: 'Spam',
        reportId: REPORT_ID,
      }),
    );
    const malformedError = await caughtError(
      service.deleteGameAsStaff(STAFF_ID, SESSION_ID, {
        reason: 'Spam',
        reportId: 'not-a-report',
      }),
    );

    expect(quizshowCodeOf(endError)).toBe('quizshow_game_not_found');
    expect(quizshowCodeOf(deleteError)).toBe('quizshow_game_not_found');
    expect(quizshowCodeOf(malformedError)).toBe('quizshow_game_not_found');
    expect(runtime.abandonSessionsOfGames).not.toHaveBeenCalled();
    expect(transactionManager.delete).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('answers game not found to staff for an event session or a deleted game', async () => {
    const { service, runtime, dataSource, transactionManager, modAudit } =
      build({ sessionGameRows: [] });

    const endError = await caughtError(
      service.endGameSessionAsStaff(STAFF_ID, SESSION_ID, { reason: 'Spam' }),
    );
    const deleteError = await caughtError(
      service.deleteGameAsStaff(STAFF_ID, SESSION_ID, { reason: 'Spam' }),
    );
    const malformedError = await caughtError(
      service.deleteGameAsStaff(STAFF_ID, 'not-a-session', { reason: 'Spam' }),
    );

    expect(quizshowCodeOf(endError)).toBe('quizshow_game_not_found');
    expect(quizshowCodeOf(deleteError)).toBe('quizshow_game_not_found');
    expect(quizshowCodeOf(malformedError)).toBe('quizshow_game_not_found');
    expect(dataSource.query).toHaveBeenCalledTimes(2);
    expect(runtime.abandonSessionsOfGames).not.toHaveBeenCalled();
    expect(dataSource.manager.delete).not.toHaveBeenCalled();
    expect(transactionManager.delete).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });
});
