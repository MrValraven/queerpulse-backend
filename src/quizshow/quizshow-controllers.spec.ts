import { RequestMethod, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { allowsSharedUploads } from '../storage/shared-upload-handlers';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminQuizshowController } from './admin-quizshow.controller';
import {
  QuizshowCreateGameDto,
  QuizshowGameInputDto,
  QuizshowOpenGameSessionDto,
} from './dto/quizshow-game.dto';
import { QuizshowImportDto } from './dto/quizshow-import.dto';
import { QuizshowJoinDto } from './dto/quizshow-join.dto';
import { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';
import { QuizshowQuizInputDto } from './dto/quizshow-quiz-input.dto';
import { QuizshowStaffActionDto } from './dto/quizshow-staff-action.dto';
import { QuizshowAccessService } from './quizshow-access.service';
import { QuizshowEventController } from './quizshow-event.controller';
import { QuizshowEventLifecycleListener } from './quizshow-event-lifecycle.listener';
import { QuizshowGamesController } from './quizshow-games.controller';
import { QuizshowGamesService } from './quizshow-games.service';
import { QuizshowGuestPushService } from './quizshow-guest-push.service';
import { QuizshowPersistenceService } from './quizshow-persistence.service';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { QuizshowRetentionService } from './quizshow-retention.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import { QuizshowSessionsService } from './quizshow-sessions.service';
import { QuizshowController } from './quizshow.controller';
import { QuizshowGateway } from './quizshow.gateway';
import { QuizshowModule } from './quizshow.module';

const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';
const USER: CurrentUserData = {
  userId: 'e0000000-0000-4000-8000-000000000001',
  restricted: false,
} as CurrentUserData;
const SLUG = 'drag-quiz-night';

const handlerOf = (
  controller: { prototype: unknown },
  methodName: string,
): ((...args: never[]) => unknown) => {
  const handler = (controller.prototype as Record<string, unknown>)[methodName];
  if (typeof handler !== 'function') {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler as (...args: never[]) => unknown;
};

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

describe('Pulse Live controllers', () => {
  it('leaves join untagged and keeps packs and every hosting route tagged', () => {
    const reflector = new Reflector();
    const featureOf = (
      controller: Type<unknown>,
      methodName: string,
    ): unknown =>
      reflector.getAllAndOverride(FEATURE_KEY, [
        handlerOf(controller, methodName),
        controller,
      ]);

    expect(featureOf(QuizshowController, 'join')).toBeUndefined();
    expect(featureOf(QuizshowController, 'listPacks')).toBe('quizshow');
    for (const controller of [
      QuizshowGamesController,
      QuizshowEventController,
    ]) {
      const methodNames = Object.getOwnPropertyNames(
        controller.prototype,
      ).filter((name) => name !== 'constructor');
      expect(methodNames.length).toBeGreaterThan(0);
      for (const methodName of methodNames) {
        expect(featureOf(controller, methodName)).toBe('quizshow');
      }
    }
    for (const methodName of ['endSession', 'deleteGame']) {
      expect(featureOf(AdminQuizshowController, methodName)).toBeUndefined();
    }
  });

  it('guards every route with ActiveMemberGuard and the four writes that reach others with NotRestrictedGuard', () => {
    expect(guardsOf(QuizshowEventController)).toEqual([ActiveMemberGuard]);
    expect(guardsOf(QuizshowController)).toEqual([ActiveMemberGuard]);

    const restrictedWrites: [{ prototype: unknown }, string][] = [
      [QuizshowEventController, 'replaceQuiz'],
      [QuizshowEventController, 'importQuiz'],
      [QuizshowEventController, 'openSession'],
      [QuizshowController, 'join'],
    ];
    for (const [controller, methodName] of restrictedWrites) {
      expect(guardsOf(handlerOf(controller, methodName))).toEqual([
        NotRestrictedGuard,
      ]);
    }

    const openRoutes: [{ prototype: unknown }, string][] = [
      [QuizshowEventController, 'getQuiz'],
      [QuizshowEventController, 'listImportSources'],
      [QuizshowEventController, 'getResults'],
      [QuizshowEventController, 'deleteResults'],
      [QuizshowController, 'listPacks'],
    ];
    for (const [controller, methodName] of openRoutes) {
      expect(guardsOf(handlerOf(controller, methodName))).toEqual([]);
    }
  });

  it.each([
    [QuizshowEventController, 'getQuiz', RequestMethod.GET, '/', undefined],
    [QuizshowEventController, 'replaceQuiz', RequestMethod.PUT, '/', undefined],
    [QuizshowEventController, 'importQuiz', RequestMethod.POST, 'import', 200],
    [
      QuizshowEventController,
      'listImportSources',
      RequestMethod.GET,
      'import-sources',
      undefined,
    ],
    [
      QuizshowEventController,
      'openSession',
      RequestMethod.POST,
      'sessions',
      undefined,
    ],
    [
      QuizshowEventController,
      'getResults',
      RequestMethod.GET,
      'results',
      undefined,
    ],
    [
      QuizshowEventController,
      'deleteResults',
      RequestMethod.DELETE,
      'results',
      204,
    ],
    [QuizshowController, 'listPacks', RequestMethod.GET, 'packs', undefined],
    [QuizshowController, 'join', RequestMethod.POST, 'join', 200],
  ])(
    'serves %p.%s on the contract method, path and status',
    (controller, methodName, method, path, httpCode) => {
      const handler = handlerOf(controller, methodName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(httpCode);
    },
  );

  it('mounts the controllers on the event and the quizshow prefixes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, QuizshowEventController)).toBe(
      'events/:slug/quizshow',
    );
    expect(Reflect.getMetadata(PATH_METADATA, QuizshowController)).toBe(
      'quizshow',
    );
  });

  it('throttles join to 20 a minute', () => {
    const join = handlerOf(QuizshowController, 'join');
    expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, join)).toBe(20);
    expect(Reflect.getMetadata(THROTTLE_TTL_KEY, join)).toBe(60000);
    expect(
      Reflect.getMetadata(
        THROTTLE_LIMIT_KEY,
        handlerOf(QuizshowController, 'listPacks'),
      ),
    ).toBeUndefined();
  });

  it("lets co-hosts re-save each other's question images", () => {
    expect(allowsSharedUploads('QuizshowEventController', 'replaceQuiz')).toBe(
      true,
    );
    expect(allowsSharedUploads('QuizshowEventController', 'importQuiz')).toBe(
      false,
    );
  });

  it('passes the caller and the body to the services', async () => {
    const quizService = {
      getQuiz: jest.fn().mockResolvedValue({ quiz: null }),
      replaceQuiz: jest.fn().mockResolvedValue({ quiz: null }),
      importQuiz: jest.fn().mockResolvedValue({ quiz: null }),
      listImportSources: jest.fn().mockResolvedValue({ items: [] }),
      listPacks: jest.fn().mockReturnValue({ items: [] }),
    };
    const sessionsService = {
      openSession: jest.fn().mockResolvedValue({
        sessionId: 'e0100000-0000-4000-8000-000000000001',
        joinCode: 'QZ4KM7',
        isGuestPushSent: true,
      }),
      getResults: jest.fn().mockResolvedValue({ podium: [] }),
      deleteResults: jest.fn().mockResolvedValue(undefined),
      join: jest.fn().mockResolvedValue({ isRejoin: false }),
    };
    const eventController = new QuizshowEventController(
      quizService as unknown as QuizshowQuizService,
      sessionsService as unknown as QuizshowSessionsService,
    );
    const quizshowController = new QuizshowController(
      quizService as unknown as QuizshowQuizService,
      sessionsService as unknown as QuizshowSessionsService,
    );
    const quizBody = {
      title: 'Drag herstory',
    } as unknown as QuizshowQuizInputDto;
    const importBody = {
      from: 'pack',
      packKey: 'drag_herstory',
    } as unknown as QuizshowImportDto;
    const openBody = {
      playMode: 'solo',
      maxTeamSize: null,
      isReviewOn: true,
      notifyGuests: true,
      shouldReplaceResults: false,
    } as unknown as QuizshowOpenSessionDto;
    const joinBody: QuizshowJoinDto = { code: 'qz4-km7' };

    await expect(eventController.getQuiz(USER, SLUG)).resolves.toEqual({
      quiz: null,
    });
    await eventController.replaceQuiz(USER, SLUG, quizBody);
    await eventController.importQuiz(USER, SLUG, importBody);
    await eventController.listImportSources(USER, SLUG);
    await expect(
      eventController.openSession(USER, SLUG, openBody),
    ).resolves.toEqual({
      sessionId: 'e0100000-0000-4000-8000-000000000001',
      joinCode: 'QZ4KM7',
      isGuestPushSent: true,
    });
    await eventController.getResults(USER, SLUG);
    await expect(
      eventController.deleteResults(USER, SLUG),
    ).resolves.toBeUndefined();
    expect(quizshowController.listPacks()).toEqual({ items: [] });
    await expect(quizshowController.join(USER, joinBody)).resolves.toEqual({
      isRejoin: false,
    });

    expect(quizService.getQuiz).toHaveBeenCalledWith(SLUG, USER.userId);
    expect(quizService.replaceQuiz).toHaveBeenCalledWith(
      SLUG,
      USER.userId,
      quizBody,
    );
    expect(quizService.importQuiz).toHaveBeenCalledWith(
      SLUG,
      USER.userId,
      importBody,
    );
    expect(quizService.listImportSources).toHaveBeenCalledWith(
      SLUG,
      USER.userId,
    );
    expect(sessionsService.openSession).toHaveBeenCalledWith(
      SLUG,
      USER.userId,
      openBody,
    );
    expect(sessionsService.getResults).toHaveBeenCalledWith(SLUG, USER.userId);
    expect(sessionsService.deleteResults).toHaveBeenCalledWith(
      SLUG,
      USER.userId,
    );
    expect(quizService.listPacks).toHaveBeenCalledWith();
    expect(sessionsService.join).toHaveBeenCalledWith(USER, joinBody);
  });

  it('guards game create, PUT, duplicate, import and session open with NotRestrictedGuard and leaves deletes and reads open', () => {
    expect(guardsOf(QuizshowGamesController)).toEqual([ActiveMemberGuard]);
    for (const methodName of [
      'createGame',
      'replaceGame',
      'duplicateGame',
      'importIntoGame',
      'openSession',
    ]) {
      expect(guardsOf(handlerOf(QuizshowGamesController, methodName))).toEqual([
        NotRestrictedGuard,
      ]);
    }
    for (const methodName of [
      'listGames',
      'getGame',
      'deleteGame',
      'listImportSources',
      'getResults',
      'deleteResults',
    ]) {
      expect(guardsOf(handlerOf(QuizshowGamesController, methodName))).toEqual(
        [],
      );
    }
  });

  it.each([
    ['listGames', RequestMethod.GET, '/', undefined],
    ['createGame', RequestMethod.POST, '/', undefined],
    ['getGame', RequestMethod.GET, ':gameId', undefined],
    ['replaceGame', RequestMethod.PUT, ':gameId', undefined],
    ['deleteGame', RequestMethod.DELETE, ':gameId', 204],
    ['duplicateGame', RequestMethod.POST, ':gameId/duplicate', undefined],
    ['importIntoGame', RequestMethod.POST, ':gameId/import', 200],
    [
      'listImportSources',
      RequestMethod.GET,
      ':gameId/import-sources',
      undefined,
    ],
    ['openSession', RequestMethod.POST, ':gameId/sessions', undefined],
    ['getResults', RequestMethod.GET, ':gameId/results', undefined],
    ['deleteResults', RequestMethod.DELETE, ':gameId/results', 204],
  ])(
    'serves QuizshowGamesController.%s on the contract method, path and status',
    (methodName, method, path, httpCode) => {
      const handler = handlerOf(QuizshowGamesController, methodName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(httpCode);
    },
  );

  it('mounts games at quizshow/games and staff routes at admin/quizshow for moderators and admins', () => {
    expect(Reflect.getMetadata(PATH_METADATA, QuizshowGamesController)).toBe(
      'quizshow/games',
    );
    expect(Reflect.getMetadata(PATH_METADATA, AdminQuizshowController)).toBe(
      'admin/quizshow',
    );
    expect(guardsOf(AdminQuizshowController)).toEqual([
      ActiveMemberGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminQuizshowController)).toEqual([
      UserRole.Moderator,
      UserRole.Admin,
    ]);
    const endSession = handlerOf(AdminQuizshowController, 'endSession');
    expect(Reflect.getMetadata(METHOD_METADATA, endSession)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, endSession)).toBe(
      'sessions/:sessionId/end',
    );
    const deleteGame = handlerOf(AdminQuizshowController, 'deleteGame');
    expect(Reflect.getMetadata(METHOD_METADATA, deleteGame)).toBe(
      RequestMethod.DELETE,
    );
    expect(Reflect.getMetadata(PATH_METADATA, deleteGame)).toBe(
      'sessions/:sessionId/game',
    );
  });

  it('reads the staff caller, the session id and a reason body on both staff routes', () => {
    for (const methodName of ['endSession', 'deleteGame']) {
      const routeArguments = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        AdminQuizshowController,
        methodName,
      ) as Record<string, { index: number; data?: unknown }>;
      expect(routeArguments[`${RouteParamtypes.PARAM}:1`]).toEqual(
        expect.objectContaining({ index: 1, data: 'sessionId' }),
      );
      expect(routeArguments[`${RouteParamtypes.BODY}:2`]).toEqual(
        expect.objectContaining({ index: 2 }),
      );
      const customArgumentKeys = Object.keys(routeArguments).filter(
        (argumentKey) => argumentKey.endsWith(':0'),
      );
      expect(customArgumentKeys).toHaveLength(1);
      const parameterTypes = Reflect.getMetadata(
        'design:paramtypes',
        AdminQuizshowController.prototype,
        methodName,
      ) as unknown[];
      expect(parameterTypes[2]).toBe(QuizshowStaffActionDto);
    }
  });

  it('answers 201 to create and duplicate and 204 to deletes', () => {
    for (const methodName of ['createGame', 'duplicateGame']) {
      const httpCode: unknown = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handlerOf(QuizshowGamesController, methodName),
      );
      // A POST without @HttpCode answers Nest's default 201.
      expect(httpCode).toBeUndefined();
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          handlerOf(QuizshowGamesController, methodName),
        ),
      ).toBe(RequestMethod.POST);
    }
    for (const [controller, methodName] of [
      [QuizshowGamesController, 'deleteGame'],
      [QuizshowGamesController, 'deleteResults'],
      [AdminQuizshowController, 'endSession'],
      [AdminQuizshowController, 'deleteGame'],
    ] as [{ prototype: unknown }, string][]) {
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          handlerOf(controller, methodName),
        ),
      ).toBe(204);
    }
  });

  it('passes the caller and the params to the services', async () => {
    const gameId = 'e0200000-0000-4000-8000-000000000001';
    const sessionId = 'e0100000-0000-4000-8000-000000000001';
    const gamesService = {
      listGames: jest.fn().mockResolvedValue({ games: [], limit: 20 }),
      createGame: jest.fn().mockResolvedValue({ quiz: null }),
      getGame: jest.fn().mockResolvedValue({ quiz: null }),
      replaceGame: jest.fn().mockResolvedValue({ quiz: null }),
      deleteGame: jest.fn().mockResolvedValue(undefined),
      duplicateGame: jest.fn().mockResolvedValue({ quiz: null }),
      importIntoGame: jest.fn().mockResolvedValue({ quiz: null }),
      listImportSources: jest.fn().mockResolvedValue([]),
      endGameSessionAsStaff: jest.fn().mockResolvedValue(undefined),
      deleteGameAsStaff: jest.fn().mockResolvedValue(undefined),
    };
    const sessionsService = {
      openGameSession: jest.fn().mockResolvedValue({
        sessionId,
        joinCode: 'QZ4KM7',
        isGuestPushSent: false,
      }),
      getGameResults: jest.fn().mockResolvedValue({ podium: [] }),
      deleteGameResults: jest.fn().mockResolvedValue(undefined),
    };
    const gamesController = new QuizshowGamesController(
      gamesService as unknown as QuizshowGamesService,
      sessionsService as unknown as QuizshowSessionsService,
    );
    const adminController = new AdminQuizshowController(
      gamesService as unknown as QuizshowGamesService,
    );
    const createBody = {
      title: 'Drag herstory',
      source: null,
    } as unknown as QuizshowCreateGameDto;
    const inputBody = {
      title: 'Drag herstory',
      isAdultsOnly: false,
    } as unknown as QuizshowGameInputDto;
    const importBody = {
      from: 'pack',
      packKey: 'drag_herstory',
    } as unknown as QuizshowImportDto;
    const openBody = {
      playMode: 'solo',
      maxTeamSize: null,
      isReviewOn: true,
      notifyGuests: false,
      shouldReplaceResults: false,
    } as unknown as QuizshowOpenGameSessionDto;
    const staffBody: QuizshowStaffActionDto = {
      reason: 'Hateful questions',
      reportId: 'e0300000-0000-4000-8000-000000000001',
    };

    await gamesController.listGames(USER);
    await gamesController.createGame(USER, createBody);
    await gamesController.getGame(USER, gameId);
    await gamesController.replaceGame(USER, gameId, inputBody);
    await expect(
      gamesController.deleteGame(USER, gameId),
    ).resolves.toBeUndefined();
    await gamesController.duplicateGame(USER, gameId);
    await gamesController.importIntoGame(USER, gameId, importBody);
    await expect(
      gamesController.openSession(USER, gameId, openBody),
    ).resolves.toEqual({
      sessionId,
      joinCode: 'QZ4KM7',
      isGuestPushSent: false,
    });
    await gamesController.getResults(USER, gameId);
    await expect(
      gamesController.deleteResults(USER, gameId),
    ).resolves.toBeUndefined();
    await adminController.endSession(USER, sessionId, staffBody);
    await adminController.deleteGame(USER, sessionId, staffBody);

    expect(gamesService.listGames).toHaveBeenCalledWith(USER.userId);
    expect(gamesService.createGame).toHaveBeenCalledWith(
      USER.userId,
      createBody,
    );
    expect(gamesService.getGame).toHaveBeenCalledWith(gameId, USER.userId);
    expect(gamesService.replaceGame).toHaveBeenCalledWith(
      gameId,
      USER.userId,
      inputBody,
    );
    expect(gamesService.deleteGame).toHaveBeenCalledWith(gameId, USER.userId);
    expect(gamesService.duplicateGame).toHaveBeenCalledWith(
      gameId,
      USER.userId,
    );
    expect(gamesService.importIntoGame).toHaveBeenCalledWith(
      gameId,
      USER.userId,
      importBody,
    );
    expect(sessionsService.openGameSession).toHaveBeenCalledWith(
      gameId,
      USER.userId,
      openBody,
    );
    expect(sessionsService.getGameResults).toHaveBeenCalledWith(
      gameId,
      USER.userId,
    );
    expect(sessionsService.deleteGameResults).toHaveBeenCalledWith(
      gameId,
      USER.userId,
    );
    expect(gamesService.endGameSessionAsStaff).toHaveBeenCalledWith(
      USER.userId,
      sessionId,
      staffBody,
    );
    expect(gamesService.deleteGameAsStaff).toHaveBeenCalledWith(
      USER.userId,
      sessionId,
      staffBody,
    );
  });

  it('wraps game import sources in items like the event route', async () => {
    const sources = [{ gameId: 'e0200000-0000-4000-8000-000000000002' }];
    const gamesService = {
      listImportSources: jest.fn().mockResolvedValue(sources),
    };
    const gamesController = new QuizshowGamesController(
      gamesService as unknown as QuizshowGamesService,
      {} as unknown as QuizshowSessionsService,
    );

    await expect(
      gamesController.listImportSources(
        USER,
        'e0200000-0000-4000-8000-000000000001',
      ),
    ).resolves.toEqual({ items: sources });
    expect(gamesService.listImportSources).toHaveBeenCalledWith(
      'e0200000-0000-4000-8000-000000000001',
      USER.userId,
    );
  });

  it('lets game owners re-save imported question images', () => {
    expect(allowsSharedUploads('QuizshowGamesController', 'replaceGame')).toBe(
      true,
    );
    expect(
      allowsSharedUploads('QuizshowGamesController', 'importIntoGame'),
    ).toBe(false);
  });

  it('registers the games service and both new controllers in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, QuizshowModule),
    ).toEqual([
      QuizshowEventController,
      QuizshowGamesController,
      AdminQuizshowController,
      QuizshowController,
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, QuizshowModule),
    ).toEqual([
      QuizshowAccessService,
      QuizshowQuizService,
      QuizshowGamesService,
      QuizshowSessionsService,
      QuizshowGuestPushService,
      QuizshowPersistenceService,
      QuizshowRuntimeService,
      QuizshowGateway,
      QuizshowRetentionService,
      QuizshowEventLifecycleListener,
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, QuizshowModule),
    ).toBeUndefined();
  });
});
