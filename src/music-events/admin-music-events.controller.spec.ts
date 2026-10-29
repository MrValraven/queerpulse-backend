import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { CheckInDto } from '../events/dto/check-in.dto';
import { GoTogetherLaunchGuard } from '../go-together/go-together-launch.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminMusicEventGuestsService } from './admin-music-event-guests.service';
import { AdminMusicEventProgramService } from './admin-music-event-program.service';
import { AdminMusicEventsController } from './admin-music-events.controller';
import { AdminMusicEventsService } from './admin-music-events.service';
import { StudioArtistSearchService } from './studio-artist-search.service';

const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';

interface RouteRecord {
  methodName: string;
  requestMethod: RequestMethod;
  path: string;
}

const prototypeRecord =
  AdminMusicEventsController.prototype as unknown as Record<
    string,
    object | undefined
  >;

const handlerOf = (methodName: string): object => {
  const handler = prototypeRecord[methodName];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

/** Routes in declaration order (Object.getOwnPropertyNames keeps it). */
const routes: RouteRecord[] = Object.getOwnPropertyNames(
  AdminMusicEventsController.prototype,
).flatMap((methodName) => {
  if (methodName === 'constructor') return [];
  const handler = handlerOf(methodName);
  const path = Reflect.getMetadata(PATH_METADATA, handler) as
    string | undefined;
  const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
    RequestMethod | undefined;
  if (path === undefined || requestMethod === undefined) return [];
  return [{ methodName, requestMethod, path }];
});

const routeNamed = (methodName: string): RouteRecord => {
  const route = routes.find((candidate) => candidate.methodName === methodName);
  if (!route) throw new Error(`No route named ${methodName}`);
  return route;
};

describe('AdminMusicEventsController', () => {
  it('guards every route with ActiveMemberGuard and RolesOrStaffGuard, the Admin tier and the music_manager_producer grant', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminMusicEventsController)).toBe(
      'admin/music-events',
    );
    expect(guardsOf(AdminMusicEventsController)).toEqual([
      ActiveMemberGuard,
      RolesOrStaffGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminMusicEventsController)).toEqual([
      UserRole.Admin,
    ]);
    expect(
      Reflect.getMetadata(STAFF_ROLES_KEY, AdminMusicEventsController),
    ).toEqual(['music_manager_producer']);
    expect(Reflect.getMetadata(FEATURE_KEY, AdminMusicEventsController)).toBe(
      'events',
    );
    expect(routes).toHaveLength(31);
  });

  it('serves no route that deletes an event', () => {
    const slugDeletes = routes.filter(
      (route) =>
        route.requestMethod === RequestMethod.DELETE && route.path === ':slug',
    );
    expect(slugDeletes).toEqual([]);
  });

  it('declares studio-artists/search before every :slug route', () => {
    const searchIndex = routes.findIndex(
      (route) => route.path === 'studio-artists/search',
    );
    const firstSlugIndex = routes.findIndex((route) =>
      route.path.startsWith(':slug'),
    );
    expect(searchIndex).toBe(0);
    expect(searchIndex).toBeLessThan(firstSlugIndex);
  });

  it('binds NotRestrictedGuard on the nine writes members get it on', () => {
    const guardedMethodNames = routes
      .filter((route) =>
        guardsOf(handlerOf(route.methodName)).includes(NotRestrictedGuard),
      )
      .map((route) => route.methodName)
      .sort();
    expect(guardedMethodNames).toEqual(
      [
        'create',
        'update',
        'addCohost',
        'sendInvites',
        'book',
        'changeRole',
        'postAnnouncement',
        'bar',
        'saveGoTogetherConfig',
      ].sort(),
    );
  });

  it('rate limits booking and announcements at 10 and the door check-in at 120 per 60 seconds', () => {
    for (const [methodName, limit] of [
      ['book', 10],
      ['postAnnouncement', 10],
      ['checkIn', 120],
    ] as const) {
      const handler = handlerOf(methodName);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBe(limit);
      expect(Reflect.getMetadata(THROTTLE_TTL_KEY, handler)).toBe(60_000);
    }
  });

  it('names the CSV download event-guests.csv', () => {
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      handlerOf('attendeesCsv'),
    ) as { name: string; value: string }[];
    expect(headers).toEqual([
      { name: 'Content-Type', value: 'text/csv; charset=utf-8' },
      {
        name: 'Content-Disposition',
        value: 'attachment; filename="event-guests.csv"',
      },
    ]);
    expect(routeNamed('attendeesCsv').path).toBe(':slug/attendees.csv');
  });

  it('tags the Go Together routes with goTogether and the launch guard', () => {
    const goTogetherRoutes = routes.filter((route) =>
      route.path.includes('go-together'),
    );
    expect(goTogetherRoutes.map((route) => route.methodName)).toEqual([
      'goTogetherConfig',
      'saveGoTogetherConfig',
      'goTogetherSummary',
    ]);
    for (const route of goTogetherRoutes) {
      const handler = handlerOf(route.methodName);
      expect(Reflect.getMetadata(FEATURE_KEY, handler)).toBe('goTogether');
      expect(guardsOf(handler)).toContain(GoTogetherLaunchGuard);
    }
    expect(guardsOf(handlerOf('saveGoTogetherConfig'))).toEqual([
      GoTogetherLaunchGuard,
      NotRestrictedGuard,
    ]);
    for (const route of routes) {
      if (goTogetherRoutes.includes(route)) continue;
      expect(
        Reflect.getMetadata(FEATURE_KEY, handlerOf(route.methodName)),
      ).toBeUndefined();
    }
  });

  describe('invite request routes', () => {
    it('declare :inviteId before the decision and parse it as a uuid', () => {
      expect(routeNamed('approveInviteRequest').path).toBe(
        ':slug/invite-requests/:inviteId/approve',
      );
      expect(routeNamed('declineInviteRequest').path).toBe(
        ':slug/invite-requests/:inviteId/decline',
      );
      for (const methodName of [
        'approveInviteRequest',
        'declineInviteRequest',
      ]) {
        const paramTypes = Reflect.getMetadata(
          'design:paramtypes',
          AdminMusicEventsController.prototype,
          methodName,
        ) as unknown[];
        expect(paramTypes).toHaveLength(3);
        const routeArguments = Reflect.getMetadata(
          '__routeArguments__',
          AdminMusicEventsController,
          methodName,
        ) as Record<string, { data: unknown; pipes: unknown[] }>;
        const inviteIdArgument = Object.values(routeArguments).find(
          (argument) => argument.data === 'inviteId',
        );
        expect(inviteIdArgument?.pipes).toEqual([ParseUUIDPipe]);
      }
    });
  });

  describe('writes', () => {
    const user: CurrentUserData = {
      userId: 'staff-1',
    } as unknown as CurrentUserData;

    const buildController = () => {
      const musicEvents = {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        cancel: jest.fn().mockResolvedValue({}),
      };
      const guests = {
        exportCsv: jest.fn().mockResolvedValue('csv'),
        promote: jest.fn().mockResolvedValue({ ok: true }),
        removeGuest: jest.fn().mockResolvedValue({ ok: true }),
        bar: jest.fn().mockResolvedValue({}),
        liftBar: jest.fn().mockResolvedValue({ ok: true }),
        sendInvites: jest.fn().mockResolvedValue({}),
        decideInviteRequest: jest.fn().mockResolvedValue({}),
        checkIn: jest.fn().mockResolvedValue({}),
      };
      const program = {
        book: jest.fn().mockResolvedValue({}),
        changeRole: jest.fn().mockResolvedValue({}),
        removePerformer: jest.fn().mockResolvedValue({}),
        postAnnouncement: jest.fn().mockResolvedValue({}),
        addCohost: jest.fn().mockResolvedValue({ ok: true }),
        removeCohost: jest.fn().mockResolvedValue({ ok: true }),
        saveGoTogetherConfig: jest.fn().mockResolvedValue({}),
      };
      const studioArtistSearch = { search: jest.fn().mockResolvedValue({}) };
      const controller = new AdminMusicEventsController(
        studioArtistSearch as unknown as StudioArtistSearchService,
        musicEvents as unknown as AdminMusicEventsService,
        guests as unknown as AdminMusicEventGuestsService,
        program as unknown as AdminMusicEventProgramService,
      );
      return { controller, musicEvents, guests, program, studioArtistSearch };
    };

    it('passes the caller as staffUserId to every write', async () => {
      const { controller, musicEvents, guests, program } = buildController();
      const eventBody = {} as never;
      await controller.create(user, eventBody);
      await controller.update(user, 'night', eventBody, { scope: 'this' });
      await controller.cancel(user, 'night', { scope: 'future' });
      await controller.book(user, 'night', {
        memberSlug: 'dj',
        role: 'dj',
      });
      await controller.changeRole(user, 'night', 'dj', {
        role: 'live',
      });
      await controller.removePerformer(user, 'night', 'dj');
      await controller.postAnnouncement(user, 'night', { body: 'hi' });
      await controller.attendeesCsv(user, 'night');
      await controller.promote(user, 'night', 'guest');
      await controller.removeGuest(user, 'night', 'guest');
      await controller.bar(user, 'night', { memberSlug: 'guest' });
      await controller.liftBar(user, 'night', 'guest');
      await controller.sendInvites(user, 'night', {
        slugs: ['guest'],
      });
      await controller.approveInviteRequest(user, 'night', 'invite-1');
      await controller.declineInviteRequest(user, 'night', 'invite-2');
      await controller.addCohost(user, 'night', { slug: 'helper' });
      await controller.removeCohost(user, 'night', 'helper');
      await controller.saveGoTogetherConfig(user, 'night', {} as never);

      const firstArguments = [
        musicEvents.create,
        musicEvents.update,
        musicEvents.cancel,
        program.book,
        program.changeRole,
        program.removePerformer,
        program.postAnnouncement,
        guests.exportCsv,
        guests.promote,
        guests.removeGuest,
        guests.bar,
        guests.liftBar,
        guests.sendInvites,
        guests.decideInviteRequest,
        program.addCohost,
        program.removeCohost,
        program.saveGoTogetherConfig,
      ].flatMap((mock) =>
        mock.mock.calls.map((call: unknown[]) => call[0] as string),
      );
      expect(firstArguments).toHaveLength(18);
      expect(new Set(firstArguments)).toEqual(new Set(['staff-1']));
    });

    it('defaults the series scope to this on update and cancel', async () => {
      const { controller, musicEvents } = buildController();
      const eventBody = {} as never;
      await controller.update(user, 'night', eventBody, {});
      await controller.cancel(user, 'night', {});
      expect(musicEvents.update.mock.calls).toEqual([
        ['staff-1', 'night', eventBody, 'this'],
      ]);
      expect(musicEvents.cancel.mock.calls).toEqual([
        ['staff-1', 'night', 'this'],
      ]);
    });

    it('sends the approve and decline decisions to the same service method', async () => {
      const { controller, guests } = buildController();
      await controller.approveInviteRequest(user, 'night', 'invite-1');
      await controller.declineInviteRequest(user, 'night', 'invite-2');
      expect(guests.decideInviteRequest.mock.calls).toEqual([
        ['staff-1', 'night', 'invite-1', 'approve'],
        ['staff-1', 'night', 'invite-2', 'decline'],
      ]);
    });

    it('checks guests in without a staff user, because door check-ins are not audited', async () => {
      const { controller, guests } = buildController();
      const dto = { memberSlug: 'guest' } as unknown as CheckInDto;
      await controller.checkIn('night', dto);
      expect(guests.checkIn.mock.calls).toEqual([['night', dto]]);
    });

    it('searches Studio artists as the caller', async () => {
      const { controller, studioArtistSearch } = buildController();
      await controller.searchStudioArtists(user, { q: 'mar', page: 2 });
      expect(studioArtistSearch.search.mock.calls).toEqual([
        ['staff-1', 'mar', 2],
      ]);
    });
  });
});
