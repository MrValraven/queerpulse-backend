import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { allowsSharedUploads } from '../storage/shared-upload-handlers';
import { QuizshowImportDto } from './dto/quizshow-import.dto';
import { QuizshowJoinDto } from './dto/quizshow-join.dto';
import { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';
import { QuizshowQuizInputDto } from './dto/quizshow-quiz-input.dto';
import { QuizshowAccessService } from './quizshow-access.service';
import { QuizshowEventController } from './quizshow-event.controller';
import { QuizshowEventLifecycleListener } from './quizshow-event-lifecycle.listener';
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
): object => {
  const handler = (controller.prototype as Record<string, object | undefined>)[
    methodName
  ];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

describe('Pulse Live controllers', () => {
  it('tags both controllers with the quizshow feature', () => {
    expect(Reflect.getMetadata(FEATURE_KEY, QuizshowEventController)).toBe(
      'quizshow',
    );
    expect(Reflect.getMetadata(FEATURE_KEY, QuizshowController)).toBe(
      'quizshow',
    );
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

  it('registers both controllers and every Pulse Live provider in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, QuizshowModule),
    ).toEqual([QuizshowEventController, QuizshowController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, QuizshowModule),
    ).toEqual([
      QuizshowAccessService,
      QuizshowQuizService,
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
