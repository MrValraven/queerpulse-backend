import { HttpException, RequestMethod, Type } from '@nestjs/common';
import type { ExecutionContext, PipeTransform } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { allowsSharedUploads } from '../storage/shared-upload-handlers';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import { AdminQuizshowController } from './admin-quizshow.controller';
import { AdminQuizshowTemplatesController } from './admin-quizshow-templates.controller';
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
import { QuizshowTemplateInputDto } from './dto/quizshow-template.dto';
import { QuizshowAccessService } from './quizshow-access.service';
import { QuizshowDevicePairingService } from './quizshow-device-pairing.service';
import {
  QuizshowDevicesController,
  QuizshowPairingClaimDto,
} from './quizshow-devices.controller';
import { QuizshowEventController } from './quizshow-event.controller';
import { QuizshowEventLifecycleListener } from './quizshow-event-lifecycle.listener';
import { QuizshowGamesController } from './quizshow-games.controller';
import { QuizshowGamesService } from './quizshow-games.service';
import { QuizshowGuestPushService } from './quizshow-guest-push.service';
import {
  QuizshowHelperPairingThrottlerGuard,
  QuizshowPairingClaimThrottlerGuard,
  QuizshowScreenPairingThrottlerGuard,
} from './quizshow-pairing-throttler.guards';
import * as quizshowPlayRules from './quizshow-play-rules';
import { QuizshowPersistenceService } from './quizshow-persistence.service';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { QuizshowRetentionService } from './quizshow-retention.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import { QuizshowSessionsService } from './quizshow-sessions.service';
import { QuizshowTemplatesService } from './quizshow-templates.service';
import { QuizshowController } from './quizshow.controller';
import { QuizshowGateway } from './quizshow.gateway';
import { QuizshowModule } from './quizshow.module';
import { QuizshowTemplateRecord } from './entities/quizshow-template.entity';

const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';
const THROTTLE_SKIP_KEY = 'THROTTLER:SKIPdefault';
const USER: CurrentUserData = {
  userId: 'e0000000-0000-4000-8000-000000000001',
  restricted: false,
} as CurrentUserData;
const SLUG = 'drag-quiz-night';
const TEMPLATE_ID = 'a7e3b1c0-5eed-4000-8000-000000000004';
const TEMPLATE_HANDLER_NAMES = [
  'listTemplates',
  'createTemplate',
  'duplicateTemplate',
  'getTemplate',
  'replaceTemplate',
  'publishTemplate',
  'unpublishTemplate',
  'deleteTemplate',
];

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
  it('leaves join untagged and keeps template cards and every hosting route tagged', () => {
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
    expect(featureOf(QuizshowController, 'listTemplates')).toBe('quizshow');
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
    for (const methodName of TEMPLATE_HANDLER_NAMES) {
      expect(featureOf(AdminQuizshowTemplatesController, methodName)).toBe(
        'quizshow',
      );
    }
  });

  it('guards every route with ActiveMemberGuard and the four writes that reach others with NotRestrictedGuard', () => {
    expect(guardsOf(QuizshowEventController)).toEqual([ActiveMemberGuard]);
    expect(guardsOf(QuizshowController)).toEqual([ActiveMemberGuard]);

    const restrictedWrites: [{ prototype: unknown }, string][] = [
      [QuizshowEventController, 'replaceQuiz'],
      [QuizshowEventController, 'importQuiz'],
      [QuizshowEventController, 'openSession'],
      [QuizshowEventController, 'refreshLobby'],
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
      [QuizshowEventController, 'getWinBadgesPreview'],
      [QuizshowEventController, 'deleteResults'],
      [QuizshowController, 'listTemplates'],
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
      'refreshLobby',
      RequestMethod.POST,
      'sessions/refresh',
      200,
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
      'getWinBadgesPreview',
      RequestMethod.GET,
      'win-badges',
      undefined,
    ],
    [
      QuizshowEventController,
      'deleteResults',
      RequestMethod.DELETE,
      'results',
      204,
    ],
    [
      QuizshowController,
      'listTemplates',
      RequestMethod.GET,
      'templates',
      undefined,
    ],
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
        handlerOf(QuizshowController, 'listTemplates'),
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
      refreshLobby: jest.fn().mockResolvedValue({ isNoop: false }),
    };
    const templatesService = {
      listPublishedCards: jest.fn().mockResolvedValue({ items: [] }),
      getTemplatePreview: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
    };
    const eventController = new QuizshowEventController(
      quizService as unknown as QuizshowQuizService,
      sessionsService as unknown as QuizshowSessionsService,
    );
    const quizshowController = new QuizshowController(
      templatesService as unknown as QuizshowTemplatesService,
      sessionsService as unknown as QuizshowSessionsService,
    );
    const quizBody = {
      title: 'Drag herstory',
    } as unknown as QuizshowQuizInputDto;
    const importBody = {
      from: 'template',
      templateId: TEMPLATE_ID,
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
    await expect(quizshowController.listTemplates()).resolves.toEqual({
      items: [],
    });
    await expect(quizshowController.join(USER, joinBody)).resolves.toEqual({
      isRejoin: false,
    });
    await expect(eventController.refreshLobby(USER, SLUG)).resolves.toEqual({
      isNoop: false,
    });
    await quizshowController.getTemplatePreview(TEMPLATE_ID);

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
    expect(templatesService.listPublishedCards).toHaveBeenCalledWith();
    expect(sessionsService.join).toHaveBeenCalledWith(USER, joinBody);
    expect(sessionsService.refreshLobby).toHaveBeenCalledWith(
      { kind: 'event', slug: SLUG },
      USER.userId,
    );
    expect(templatesService.getTemplatePreview).toHaveBeenCalledWith(
      TEMPLATE_ID,
    );
  });

  it('guards game create, PUT, duplicate, import and session open with NotRestrictedGuard and leaves deletes and reads open', () => {
    expect(guardsOf(QuizshowGamesController)).toEqual([ActiveMemberGuard]);
    for (const methodName of [
      'createGame',
      'replaceGame',
      'duplicateGame',
      'importIntoGame',
      'openSession',
      'refreshLobby',
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
    ['refreshLobby', RequestMethod.POST, ':gameId/sessions/refresh', 200],
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
      refreshLobby: jest.fn().mockResolvedValue({ isNoop: true }),
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
      from: 'template',
      templateId: TEMPLATE_ID,
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
    await expect(gamesController.refreshLobby(USER, gameId)).resolves.toEqual({
      isNoop: true,
    });
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
    expect(sessionsService.refreshLobby).toHaveBeenCalledWith(
      { kind: 'game', gameId },
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

  it('mounts the staff template routes at admin/quizshow/templates for staff with Pulse Live access', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminQuizshowTemplatesController),
    ).toBe('admin/quizshow/templates');
    expect(
      Reflect.getMetadata(FEATURE_KEY, AdminQuizshowTemplatesController),
    ).toBe('quizshow');
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminQuizshowTemplatesController),
    ).toEqual([UserRole.Moderator, UserRole.Admin]);
    expect(guardsOf(AdminQuizshowTemplatesController)).toEqual([
      ActiveMemberGuard,
      RolesGuard,
    ]);
  });

  it.each([
    ['listTemplates', RequestMethod.GET, '/', undefined],
    ['createTemplate', RequestMethod.POST, '/', undefined],
    [
      'duplicateTemplate',
      RequestMethod.POST,
      ':templateId/duplicate',
      undefined,
    ],
    ['getTemplate', RequestMethod.GET, ':templateId', undefined],
    ['replaceTemplate', RequestMethod.PUT, ':templateId', undefined],
    ['publishTemplate', RequestMethod.POST, ':templateId/publish', 200],
    ['unpublishTemplate', RequestMethod.POST, ':templateId/unpublish', 200],
    ['deleteTemplate', RequestMethod.DELETE, ':templateId', 204],
  ])(
    'serves AdminQuizshowTemplatesController.%s on the contract method, path and status',
    (methodName, method, path, httpCode) => {
      const handler = handlerOf(AdminQuizshowTemplatesController, methodName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(httpCode);
    },
  );

  it('passes the caller, the template id and the body to the templates service', async () => {
    const templatesService = {
      listTemplateRows: jest.fn().mockResolvedValue({ items: [] }),
      createTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      duplicateTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      getTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      replaceTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      publishTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      unpublishTemplate: jest.fn().mockResolvedValue({ id: TEMPLATE_ID }),
      deleteTemplate: jest.fn().mockResolvedValue(undefined),
    };
    const templatesController = new AdminQuizshowTemplatesController(
      templatesService as unknown as QuizshowTemplatesService,
    );
    const inputBody = {
      card: {
        title: { en: 'Drag herstory', pt: 'Herstory drag' },
        description: { en: 'A quiz', pt: 'Um quiz' },
      },
      staffNotes: '',
    } as unknown as QuizshowTemplateInputDto;

    await expect(templatesController.listTemplates()).resolves.toEqual({
      items: [],
    });
    await templatesController.createTemplate(USER);
    await templatesController.duplicateTemplate(USER, TEMPLATE_ID);
    await templatesController.getTemplate(TEMPLATE_ID);
    await templatesController.replaceTemplate(USER, TEMPLATE_ID, inputBody);
    await templatesController.publishTemplate(USER, TEMPLATE_ID);
    await templatesController.unpublishTemplate(USER, TEMPLATE_ID);
    await expect(
      templatesController.deleteTemplate(USER, TEMPLATE_ID),
    ).resolves.toBeUndefined();

    expect(templatesService.listTemplateRows).toHaveBeenCalledWith();
    expect(templatesService.createTemplate).toHaveBeenCalledWith(USER.userId);
    expect(templatesService.duplicateTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      USER.userId,
    );
    expect(templatesService.getTemplate).toHaveBeenCalledWith(TEMPLATE_ID);
    expect(templatesService.replaceTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      USER.userId,
      inputBody,
    );
    expect(templatesService.publishTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      USER.userId,
    );
    expect(templatesService.unpublishTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      USER.userId,
    );
    expect(templatesService.deleteTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      USER.userId,
    );
  });

  it("lets staff re-save each other's template images", () => {
    expect(
      allowsSharedUploads(
        'AdminQuizshowTemplatesController',
        'replaceTemplate',
      ),
    ).toBe(true);
    expect(
      allowsSharedUploads(
        'AdminQuizshowTemplatesController',
        'publishTemplate',
      ),
    ).toBe(false);
  });

  it('registers the templates service, the template entity and the staff templates controller in the module', () => {
    const importedModules = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      QuizshowModule,
    ) as { module?: unknown; providers?: unknown[] }[];
    expect(importedModules.length).toBeGreaterThan(0);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, QuizshowModule),
    ).toContain(AdminQuizshowTemplatesController);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, QuizshowModule),
    ).toContain(QuizshowTemplatesService);
    const typeOrmFeature = importedModules.find(
      (importedModule) =>
        Array.isArray(importedModule.providers) &&
        importedModule.providers.some(
          (provider) =>
            (provider as { provide?: unknown }).provide ===
            getRepositoryToken(QuizshowTemplateRecord),
        ),
    );
    expect(typeOrmFeature).toBeDefined();
  });

  it('registers the games service and both new controllers in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, QuizshowModule),
    ).toEqual([
      QuizshowEventController,
      QuizshowGamesController,
      AdminQuizshowController,
      AdminQuizshowTemplatesController,
      QuizshowController,
      QuizshowDevicesController,
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, QuizshowModule),
    ).toEqual([
      QuizshowAccessService,
      QuizshowQuizService,
      QuizshowGamesService,
      QuizshowTemplatesService,
      QuizshowSessionsService,
      QuizshowGuestPushService,
      QuizshowPersistenceService,
      QuizshowRuntimeService,
      QuizshowGateway,
      QuizshowRetentionService,
      QuizshowEventLifecycleListener,
      QuizshowDevicePairingService,
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, QuizshowModule),
    ).toBeUndefined();
  });
});

/** The protected members the pairing throttler guards override. */
interface PairingGuardInternals {
  getTracker(request: Record<string, unknown>): Promise<string>;
  handleRequest(requestProps: ThrottlerRequest): Promise<boolean>;
  throwThrottlingException(
    context: ExecutionContext,
    detail: { timeToBlockExpire: number },
  ): Promise<void>;
}

const pairingGuardInternals = (GuardClass: unknown): PairingGuardInternals =>
  new (GuardClass as new (...args: unknown[]) => PairingGuardInternals)(
    {},
    {},
    {},
  );

const headersOf = (handler: object): { name: string; value: string }[] =>
  (Reflect.getMetadata(HEADERS_METADATA, handler) as
    { name: string; value: string }[] | undefined) ?? [];

describe('Pulse Live device and join preview routes', () => {
  const PAIRING_ID = 'e0400000-0000-4000-8000-000000000001';
  const POLL_TOKEN = 'a'.repeat(43);
  const DEVICE_HANDLER_NAMES = [
    'startScreenPairing',
    'startHelperPairing',
    'claimPairing',
    'getJoinPreview',
  ];

  it('mounts on quizshow with no class guard and no class feature tag', () => {
    expect(Reflect.getMetadata(PATH_METADATA, QuizshowDevicesController)).toBe(
      'quizshow',
    );
    expect(guardsOf(QuizshowDevicesController)).toEqual([]);
    expect(
      Reflect.getMetadata(FEATURE_KEY, QuizshowDevicesController),
    ).toBeUndefined();
  });

  it.each([
    ['startScreenPairing', RequestMethod.POST, 'device-pairings/screen', 201],
    ['startHelperPairing', RequestMethod.POST, 'device-pairings/helper', 201],
    [
      'claimPairing',
      RequestMethod.POST,
      'device-pairings/:pairingId/claim',
      200,
    ],
    ['getJoinPreview', RequestMethod.GET, 'join-preview/:code', undefined],
  ])(
    'serves QuizshowDevicesController.%s on the contract method, path and status',
    (methodName, method, path, httpCode) => {
      const handler = handlerOf(QuizshowDevicesController, methodName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(httpCode);
    },
  );

  it('makes the screen start, the claim and the preview public and keeps the helper start signed in', () => {
    const isPublic = (methodName: string): unknown =>
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        handlerOf(QuizshowDevicesController, methodName),
      );
    expect(isPublic('startScreenPairing')).toBe(true);
    expect(isPublic('claimPairing')).toBe(true);
    expect(isPublic('getJoinPreview')).toBe(true);
    expect(isPublic('startHelperPairing')).toBeUndefined();
  });

  it('tags no device route with a feature, so early access never 404s a TV or a signed-out guest', () => {
    for (const methodName of DEVICE_HANDLER_NAMES) {
      expect(
        Reflect.getMetadata(
          FEATURE_KEY,
          handlerOf(QuizshowDevicesController, methodName),
        ),
      ).toBeUndefined();
    }
  });

  it('starts a screen pairing while Pulse Live is playable and answers 404 when it is not', () => {
    const pairingService = {
      startPairing: jest.fn().mockReturnValue({ pairingId: PAIRING_ID }),
    };
    const controller = new QuizshowDevicesController(
      pairingService as unknown as QuizshowDevicePairingService,
      {} as unknown as QuizshowSessionsService,
    );
    const isPlayable = jest
      .spyOn(quizshowPlayRules, 'isQuizshowPlayable')
      .mockReturnValue(true);
    expect(controller.startScreenPairing()).toEqual({ pairingId: PAIRING_ID });

    isPlayable.mockReturnValue(false);
    let refusal: unknown = null;
    try {
      controller.startScreenPairing();
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(404);
    expect(pairingService.startPairing).toHaveBeenCalledTimes(1);
    isPlayable.mockRestore();
  });

  it('guards the starts with their pairing throttlers and the helper start with the member guards first', () => {
    expect(
      guardsOf(handlerOf(QuizshowDevicesController, 'startScreenPairing')),
    ).toEqual([QuizshowScreenPairingThrottlerGuard]);
    expect(
      guardsOf(handlerOf(QuizshowDevicesController, 'startHelperPairing')),
    ).toEqual([
      ActiveMemberGuard,
      NotRestrictedGuard,
      QuizshowHelperPairingThrottlerGuard,
    ]);
    expect(
      guardsOf(handlerOf(QuizshowDevicesController, 'claimPairing')),
    ).toEqual([QuizshowPairingClaimThrottlerGuard]);
    expect(
      guardsOf(handlerOf(QuizshowDevicesController, 'getJoinPreview')),
    ).toEqual([]);
  });

  it('skips the global bucket on the claim, throttles the preview to 30 a minute and leaves the starts to their guards', () => {
    const claim = handlerOf(QuizshowDevicesController, 'claimPairing');
    const preview = handlerOf(QuizshowDevicesController, 'getJoinPreview');
    expect(Reflect.getMetadata(THROTTLE_SKIP_KEY, claim)).toBe(true);
    expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, claim)).toBeUndefined();
    expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, preview)).toBe(30);
    expect(Reflect.getMetadata(THROTTLE_TTL_KEY, preview)).toBe(60000);
    for (const methodName of ['startScreenPairing', 'startHelperPairing']) {
      expect(
        Reflect.getMetadata(
          THROTTLE_LIMIT_KEY,
          handlerOf(QuizshowDevicesController, methodName),
        ),
      ).toBeUndefined();
    }
  });

  it('sets no-store on every device route and noindex on the preview', () => {
    for (const methodName of DEVICE_HANDLER_NAMES) {
      expect(
        headersOf(handlerOf(QuizshowDevicesController, methodName)),
      ).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    }
    expect(
      headersOf(handlerOf(QuizshowDevicesController, 'getJoinPreview')),
    ).toContainEqual({ name: 'X-Robots-Tag', value: 'noindex' });
    expect(
      headersOf(handlerOf(QuizshowDevicesController, 'claimPairing')),
    ).not.toContainEqual(expect.objectContaining({ name: 'X-Robots-Tag' }));
  });

  it('passes the kind, the caller, the pairing id, the poll token and the code to the services', async () => {
    const pairingStart = {
      pairingId: PAIRING_ID,
      pairingCode: '234567',
      pollToken: POLL_TOKEN,
      expiresAt: 1_800_000,
    };
    const pairingService = {
      startPairing: jest.fn().mockReturnValue(pairingStart),
      claimPairing: jest
        .fn()
        .mockReturnValue({ status: 'waiting', expiresAt: 1_800_000 }),
    };
    const sessionsService = {
      joinPreview: jest
        .fn()
        .mockResolvedValue({ quizTitle: 'Drag herstory', status: 'lobby' }),
    };
    const controller = new QuizshowDevicesController(
      pairingService as unknown as QuizshowDevicePairingService,
      sessionsService as unknown as QuizshowSessionsService,
    );

    const isPlayable = jest
      .spyOn(quizshowPlayRules, 'isQuizshowPlayable')
      .mockReturnValue(true);
    expect(controller.startScreenPairing()).toEqual(pairingStart);
    isPlayable.mockRestore();
    expect(controller.startHelperPairing(USER)).toEqual(pairingStart);
    expect(
      controller.claimPairing(PAIRING_ID, { pollToken: POLL_TOKEN }),
    ).toEqual({ status: 'waiting', expiresAt: 1_800_000 });
    await expect(controller.getJoinPreview('qz4-km7')).resolves.toEqual({
      quizTitle: 'Drag herstory',
      status: 'lobby',
    });

    expect(pairingService.startPairing).toHaveBeenNthCalledWith(
      1,
      'screen',
      null,
    );
    expect(pairingService.startPairing).toHaveBeenNthCalledWith(
      2,
      'helper',
      USER.userId,
    );
    expect(pairingService.claimPairing).toHaveBeenCalledWith(
      PAIRING_ID,
      POLL_TOKEN,
    );
    expect(sessionsService.joinPreview).toHaveBeenCalledWith('qz4-km7');
  });

  it('answers the preview with the quiz title and status only', async () => {
    const sessionsService = {
      joinPreview: jest.fn().mockResolvedValue({
        quizTitle: 'Drag herstory',
        status: 'running',
        eventTitle: 'Drag quiz night',
        hostName: 'Philippine',
        playerCount: 12,
        isAdultsOnly: true,
      }),
    };
    const controller = new QuizshowDevicesController(
      {} as unknown as QuizshowDevicePairingService,
      sessionsService as unknown as QuizshowSessionsService,
    );

    const preview = await controller.getJoinPreview('QZ4KM7');
    expect(preview).toEqual({ quizTitle: 'Drag herstory', status: 'running' });
    expect(Object.keys(preview).sort()).toEqual(['quizTitle', 'status']);
  });

  it('answers a malformed pairing id with quizshow_pairing_not_found', async () => {
    const routeArguments = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      QuizshowDevicesController,
      'claimPairing',
    ) as Record<
      string,
      { index: number; data?: unknown; pipes?: PipeTransform[] }
    >;
    const pairingIdArgument = routeArguments[`${RouteParamtypes.PARAM}:0`];
    expect(pairingIdArgument).toEqual(
      expect.objectContaining({ index: 0, data: 'pairingId' }),
    );
    const uuidPipe = pairingIdArgument?.pipes?.[0];
    if (!uuidPipe) {
      throw new Error('the pairing id has no pipe');
    }
    const refusal: unknown = await Promise.resolve(
      uuidPipe.transform('not-a-pairing-id', { type: 'param' }),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(404);
    expect((refusal as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'quizshow_pairing_not_found' }),
    );
    await expect(
      Promise.resolve(uuidPipe.transform(PAIRING_ID, { type: 'param' })),
    ).resolves.toBe(PAIRING_ID);
  });

  it('reads the claim body as a 43 character poll token', async () => {
    const parameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      QuizshowDevicesController.prototype,
      'claimPairing',
    ) as unknown[];
    expect(parameterTypes[1]).toBe(QuizshowPairingClaimDto);

    const problemsOf = (body: Record<string, unknown>) =>
      validate(plainToInstance(QuizshowPairingClaimDto, body));
    await expect(problemsOf({ pollToken: POLL_TOKEN })).resolves.toEqual([]);
    for (const pollToken of ['a'.repeat(42), 'a'.repeat(44), 43]) {
      const problems = await problemsOf({ pollToken });
      expect(problems.map((problem) => problem.property)).toEqual([
        'pollToken',
      ]);
    }
  });
});

describe('Pulse Live pairing throttler guards', () => {
  it('buckets screen starts by IP and helper starts by member', async () => {
    const screenGuard = pairingGuardInternals(
      QuizshowScreenPairingThrottlerGuard,
    );
    const helperGuard = pairingGuardInternals(
      QuizshowHelperPairingThrottlerGuard,
    );
    await expect(screenGuard.getTracker({ ip: '203.0.113.7' })).resolves.toBe(
      'quizshow-screen-pairing:203.0.113.7',
    );
    await expect(
      helperGuard.getTracker({ ip: '203.0.113.7', user: USER }),
    ).resolves.toBe(`quizshow-helper-pairing:${USER.userId}`);
    await expect(helperGuard.getTracker({ ip: '203.0.113.7' })).resolves.toBe(
      'quizshow-helper-pairing-ip:203.0.113.7',
    );
  });

  it('counts IPv6 screen starts by /64 and gives unparseable addresses one shared bucket', async () => {
    const screenGuard = pairingGuardInternals(
      QuizshowScreenPairingThrottlerGuard,
    );
    const helperGuard = pairingGuardInternals(
      QuizshowHelperPairingThrottlerGuard,
    );
    const firstTracker = await screenGuard.getTracker({
      ip: '2001:db8:aa:bb:1111:2222:3333:4444',
    });
    const secondTracker = await screenGuard.getTracker({
      ip: '2001:db8:aa:bb:9999:8888:7777:6666',
    });
    const otherNetworkTracker = await screenGuard.getTracker({
      ip: '2001:db8:aa:cc:1111:2222:3333:4444',
    });
    expect(secondTracker).toBe(firstTracker);
    expect(otherNetworkTracker).not.toBe(firstTracker);
    await expect(
      screenGuard.getTracker({ ip: '::ffff:203.0.113.7' }),
    ).resolves.toBe('quizshow-screen-pairing:203.0.113.7');
    await expect(
      screenGuard.getTracker({ ip: 'not-an-address' }),
    ).resolves.toBe('quizshow-screen-pairing:unknown');
    await expect(screenGuard.getTracker({})).resolves.toBe(
      'quizshow-screen-pairing:unknown',
    );
    await expect(
      helperGuard.getTracker({ ip: '2001:db8:aa:bb:1111:2222:3333:4444' }),
    ).resolves.toBe(
      await helperGuard.getTracker({ ip: '2001:db8:aa:bb:5555::1' }),
    );
  });

  it('runs a claim through a 180 a minute network bucket and a 60 a minute pairing bucket, whatever the skip metadata', async () => {
    const guard = pairingGuardInternals(
      QuizshowPairingClaimThrottlerGuard,
    ) as PairingGuardInternals & {
      canActivate(context: ExecutionContext): Promise<boolean>;
    };
    const handled: ThrottlerRequest[] = [];
    const handleRequest = jest
      .spyOn(guard, 'handleRequest')
      .mockImplementation((requestProps: ThrottlerRequest) => {
        handled.push(requestProps);
        return Promise.resolve(true);
      });
    const context = {
      getType: () => 'http',
      getClass: () => QuizshowDevicesController,
      getHandler: () => handlerOf(QuizshowDevicesController, 'claimPairing'),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(handleRequest).toHaveBeenCalledTimes(2);
    const [networkBucket, pairingBucket] = handled;
    expect(networkBucket).toEqual(
      expect.objectContaining({ limit: 180, ttl: 60000, blockDuration: 60000 }),
    );
    expect(pairingBucket).toEqual(
      expect.objectContaining({ limit: 60, ttl: 60000, blockDuration: 60000 }),
    );
    const pairingId = 'E0400000-0000-4000-8000-000000000001';
    const venueRequest = {
      ip: '2001:db8:aa:bb:1111:2222:3333:4444',
      params: { pairingId },
    };
    await expect(
      networkBucket?.getTracker(venueRequest, context),
    ).resolves.toBe(
      await networkBucket?.getTracker(
        { ip: '2001:db8:aa:bb:9999::1', params: { pairingId: 'x' } },
        context,
      ),
    );
    await expect(
      pairingBucket?.getTracker(venueRequest, context),
    ).resolves.toBe(`quizshow-claim-pairing:${pairingId.toLowerCase()}`);
    await expect(
      pairingBucket?.getTracker(
        { ip: '203.0.113.7', params: { pairingId: 'not-a-pairing-id' } },
        context,
      ),
    ).resolves.toBe('quizshow-claim-pairing:malformed');
    // The poll token in the body never keys a bucket.
    const bodyRequest = {
      ip: '203.0.113.7',
      params: { pairingId },
      body: { pollToken: 'a'.repeat(43) },
    };
    for (const bucket of [networkBucket, pairingBucket]) {
      await expect(
        bucket?.getTracker(bodyRequest, context),
      ).resolves.not.toContain('aaaa');
    }

    handleRequest.mockImplementation((requestProps: ThrottlerRequest) =>
      Promise.resolve(requestProps.limit !== 60),
    );
    await expect(guard.canActivate(context)).resolves.toBe(false);

    const refusal: unknown = await guard
      .throwThrottlingException(context, { timeToBlockExpire: 60 })
      .catch((error: unknown) => error);
    expect((refusal as HttpException).getStatus()).toBe(429);
    expect((refusal as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'quizshow_pairing_rate_limited' }),
    );
    handleRequest.mockRestore();
  });

  it.each([
    QuizshowScreenPairingThrottlerGuard,
    QuizshowHelperPairingThrottlerGuard,
  ])(
    '%p allows 10 starts in 10 minutes and refuses with quizshow_pairing_rate_limited',
    async (GuardClass) => {
      const guard = pairingGuardInternals(GuardClass);
      const superHandleRequest = jest
        .spyOn(
          HttpThrottlerGuard.prototype as unknown as Pick<
            PairingGuardInternals,
            'handleRequest'
          >,
          'handleRequest',
        )
        .mockResolvedValue(true);
      await guard.handleRequest({
        context: {} as never,
        limit: 999,
        ttl: 1,
        blockDuration: 1,
        throttler: {} as never,
        generateKey: jest.fn(),
      } as unknown as ThrottlerRequest);
      expect(superHandleRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          ttl: 600000,
          blockDuration: 600000,
        }),
      );
      superHandleRequest.mockRestore();

      const refusal: unknown = await guard
        .throwThrottlingException({} as ExecutionContext, {
          timeToBlockExpire: 600,
        })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(HttpException);
      expect((refusal as HttpException).getStatus()).toBe(429);
      expect((refusal as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'quizshow_pairing_rate_limited' }),
      );
    },
  );
});

describe('Pulse Live Swagger responses', () => {
  /** The response descriptions `@nestjs/swagger` keeps on a route handler, by status. */
  const documentedResponses = (
    handler: (...parameters: never[]) => unknown,
  ): Record<string, { description?: string }> =>
    (Reflect.getMetadata('swagger/apiResponse', handler) ?? {}) as Record<
      string,
      { description?: string }
    >;

  it('documents the rematch refusals on both lobby opens', () => {
    for (const handler of [
      handlerOf(QuizshowEventController, 'openSession'),
      handlerOf(QuizshowGamesController, 'openSession'),
    ]) {
      const responses = documentedResponses(handler);
      expect(responses['404']?.description).toContain(
        'quizshow_rematch_not_found',
      );
      expect(responses['409']?.description).toContain(
        'quizshow_rematch_expired',
      );
    }
  });

  it('documents the append conflict and its four limit refusals on both imports', () => {
    for (const handler of [
      handlerOf(QuizshowEventController, 'importQuiz'),
      handlerOf(QuizshowGamesController, 'importIntoGame'),
    ]) {
      const responses = documentedResponses(handler);
      expect(responses['409']?.description).toContain('quizshow_quiz_changed');
      for (const code of [
        'quizshow_import_round_not_found',
        'quizshow_import_too_many_rounds',
        'quizshow_import_too_many_questions',
        'quizshow_import_too_many_wheels',
      ]) {
        expect(responses['422']?.description).toContain(code);
      }
    }
  });

  it('documents the join lock refusal on join', () => {
    expect(
      documentedResponses(handlerOf(QuizshowController, 'join'))['403']
        ?.description,
    ).toContain('quizshow_joining_locked');
  });
});
