import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminQuizBadgesController } from './admin-quiz-badges.controller';
import { AdminQuizEventBadgesController } from './admin-quiz-event-badges.controller';
import { QuizBadgeLibraryService } from './quiz-badge-library.service';
import { QuizEventBadgesService } from './quiz-event-badges.service';

// @nestjs/throttler does not re-export `throttler.constants` from its package
// root; `@Throttle` writes `THROTTLER:LIMIT` and `THROTTLER:TTL` plus the
// throttler name onto the handler.
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

const EVENT_ID = 'e1000000-0000-4000-8000-000000000001';
const WINNER_ID = 'f1000000-0000-4000-8000-000000000002';
const DEFINITION_ID = 'd1000000-0000-4000-8000-000000000003';
const user = { userId: 'admin-1', restricted: false } as CurrentUserData;

type Handler = (...args: unknown[]) => unknown;

function handlerOf(controller: { prototype: object }, name: string): Handler {
  const handler = (controller.prototype as Record<string, Handler | undefined>)[
    name
  ];
  if (!handler) {
    throw new Error(`No handler named ${name} on the controller`);
  }
  return handler;
}

describe('quiz win badge admin controllers', () => {
  it.each([AdminQuizBadgesController, AdminQuizEventBadgesController])(
    'admits staff with Pulse Live access on %p',
    (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        ActiveMemberGuard,
        RolesGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual([
        UserRole.Moderator,
        UserRole.Admin,
      ]);
      expect(Reflect.getMetadata(FEATURE_KEY, controller)).toBe('quizshow');
    },
  );

  it('mounts the two prefixes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminQuizBadgesController)).toBe(
      'admin/quizshow/badges',
    );
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminQuizEventBadgesController),
    ).toBe('admin/quizshow/events');
  });

  it.each([
    [
      AdminQuizBadgesController,
      'listBadges',
      RequestMethod.GET,
      '/',
      undefined,
    ],
    [
      AdminQuizBadgesController,
      'createBadge',
      RequestMethod.POST,
      '/',
      undefined,
    ],
    [
      AdminQuizBadgesController,
      'updateBadge',
      RequestMethod.PATCH,
      ':definitionId',
      undefined,
    ],
    [
      AdminQuizBadgesController,
      'archiveBadge',
      RequestMethod.POST,
      ':definitionId/archive',
      HttpStatus.OK,
    ],
    [
      AdminQuizBadgesController,
      'restoreBadge',
      RequestMethod.POST,
      ':definitionId/restore',
      HttpStatus.OK,
    ],
    [
      AdminQuizBadgesController,
      'deleteBadge',
      RequestMethod.DELETE,
      ':definitionId',
      HttpStatus.NO_CONTENT,
    ],
    [
      AdminQuizEventBadgesController,
      'searchEvents',
      RequestMethod.GET,
      '/',
      undefined,
    ],
    [
      AdminQuizEventBadgesController,
      'saveEventBadges',
      RequestMethod.PUT,
      ':eventId/badges',
      undefined,
    ],
    [
      AdminQuizEventBadgesController,
      'getEventBadges',
      RequestMethod.GET,
      ':eventId/badges',
      undefined,
    ],
    [
      AdminQuizEventBadgesController,
      'revokeWin',
      RequestMethod.POST,
      ':eventId/winners/:winnerId/revoke',
      HttpStatus.OK,
    ],
  ])(
    'serves %p.%s on the contract method, path and status',
    (controller, handlerName, method, path, httpCode) => {
      const handler = handlerOf(controller, handlerName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(httpCode);
    },
  );

  it.each([
    [AdminQuizBadgesController, 'createBadge'],
    [AdminQuizBadgesController, 'updateBadge'],
    [AdminQuizBadgesController, 'archiveBadge'],
    [AdminQuizBadgesController, 'restoreBadge'],
    [AdminQuizBadgesController, 'deleteBadge'],
    [AdminQuizEventBadgesController, 'saveEventBadges'],
    [AdminQuizEventBadgesController, 'revokeWin'],
  ])('throttles the write %p.%s at 30 a minute', (controller, handlerName) => {
    const handler = handlerOf(controller, handlerName);
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(30);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(
      60_000,
    );
  });

  it.each([
    [AdminQuizBadgesController, 'listBadges'],
    [AdminQuizEventBadgesController, 'searchEvents'],
    [AdminQuizEventBadgesController, 'getEventBadges'],
  ])(
    'leaves the read %p.%s on the default throttle',
    (controller, handlerName) => {
      expect(
        Reflect.getMetadata(
          `${THROTTLER_LIMIT}default`,
          handlerOf(controller, handlerName),
        ),
      ).toBeUndefined();
    },
  );
});

describe('AdminQuizBadgesController handlers', () => {
  const library = {
    listLibrary: jest.fn().mockResolvedValue({ items: [] }),
    create: jest.fn().mockResolvedValue({ id: DEFINITION_ID }),
    update: jest.fn().mockResolvedValue({ id: DEFINITION_ID }),
    archive: jest.fn().mockResolvedValue({ id: DEFINITION_ID }),
    restore: jest.fn().mockResolvedValue({ id: DEFINITION_ID }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new AdminQuizBadgesController(
    library as unknown as QuizBadgeLibraryService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('lists the library', async () => {
    await expect(controller.listBadges()).resolves.toEqual({ items: [] });
    expect(library.listLibrary).toHaveBeenCalledWith();
  });

  it('passes the caller id and the body to create', async () => {
    const body = { name: { en: 'Quiz champion' } };
    await controller.createBadge(user, body);
    expect(library.create).toHaveBeenCalledWith('admin-1', body);
  });

  it('passes the definition id and the body to update, with no caller id', async () => {
    const body = { tint: 'jade' };
    await controller.updateBadge(DEFINITION_ID, body);
    expect(library.update).toHaveBeenCalledWith(DEFINITION_ID, body);
  });

  it('passes the caller id and the definition id to archive, restore and delete', async () => {
    await controller.archiveBadge(user, DEFINITION_ID);
    await controller.restoreBadge(user, DEFINITION_ID);
    await controller.deleteBadge(user, DEFINITION_ID);
    expect(library.archive).toHaveBeenCalledWith('admin-1', DEFINITION_ID);
    expect(library.restore).toHaveBeenCalledWith('admin-1', DEFINITION_ID);
    expect(library.remove).toHaveBeenCalledWith('admin-1', DEFINITION_ID);
  });
});

describe('AdminQuizEventBadgesController handlers', () => {
  const eventBadges = {
    searchEvents: jest.fn().mockResolvedValue({ data: [] }),
    saveSetup: jest.fn().mockResolvedValue({}),
    getSetup: jest.fn().mockResolvedValue({}),
    revokeWinner: jest.fn().mockResolvedValue({}),
  };
  const eventsController = new AdminQuizEventBadgesController(
    eventBadges as unknown as QuizEventBadgesService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('passes the caller id and raw query strings through', async () => {
    await eventsController.searchEvents('pride', '2');
    expect(eventBadges.searchEvents).toHaveBeenCalledWith('pride', '2');
    await eventsController.revokeWin(user, EVENT_ID, WINNER_ID, {
      reason: 'Wrong team entered',
    });
    expect(eventBadges.revokeWinner).toHaveBeenCalledWith(
      'admin-1',
      EVENT_ID,
      WINNER_ID,
      { reason: 'Wrong team entered' },
    );
  });

  it('passes an absent query and page through as undefined', async () => {
    await eventsController.searchEvents();
    expect(eventBadges.searchEvents).toHaveBeenCalledWith(undefined, undefined);
  });

  it('saves and reads the setup of the event named in the path', async () => {
    const body = { games: [{ gameNumber: 1, badgeDefinitionIds: [] }] };
    await eventsController.saveEventBadges(user, EVENT_ID, body);
    await eventsController.getEventBadges(EVENT_ID);
    expect(eventBadges.saveSetup).toHaveBeenCalledWith(
      'admin-1',
      EVENT_ID,
      body,
    );
    expect(eventBadges.getSetup).toHaveBeenCalledWith(EVENT_ID);
  });
});
