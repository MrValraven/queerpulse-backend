import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { ListingTeamAlertsListener } from './listing-team-alerts.listener';
import { ListingTeamLinksController } from './listing-team-links.controller';
import { ListingTeamLinksService } from './listing-team-links.service';
import { ListingTeamController } from './listing-team.controller';
import { ListingTeamService } from './listing-team.service';
import { ListingsController } from './listings.controller';
import { ListingsModule } from './listings.module';

type ControllerClass = { prototype: unknown };

const handlerOf = (controller: ControllerClass, methodName: string): object => {
  const handler = (controller.prototype as Record<string, object | undefined>)[
    methodName
  ];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];

// The metadata keys `@Throttle({ default: ... })` writes on a handler.
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';
const DEFAULT_STATUS = undefined;

interface RouteRow {
  handler: string;
  method: RequestMethod;
  path: string;
  status: number | undefined;
}

const teamRoutes: RouteRow[] = [
  {
    handler: 'list',
    method: RequestMethod.GET,
    path: ':ref/team',
    status: DEFAULT_STATUS,
  },
  {
    handler: 'searchCandidates',
    method: RequestMethod.GET,
    path: ':ref/team/candidates',
    status: DEFAULT_STATUS,
  },
  {
    handler: 'invite',
    method: RequestMethod.POST,
    path: ':ref/team/invites',
    status: 201,
  },
  {
    handler: 'inviteMember',
    method: RequestMethod.POST,
    path: ':ref/team/member-invites',
    status: 201,
  },
  {
    handler: 'reorder',
    method: RequestMethod.PUT,
    path: ':ref/team/order',
    status: 200,
  },
  {
    handler: 'approve',
    method: RequestMethod.POST,
    path: ':ref/team/:memberId/approve',
    status: 200,
  },
  {
    handler: 'decline',
    method: RequestMethod.POST,
    path: ':ref/team/:memberId/decline',
    status: 204,
  },
  {
    handler: 'cancel',
    method: RequestMethod.POST,
    path: ':ref/team/:memberId/cancel',
    status: 204,
  },
  {
    handler: 'updateRoleLabel',
    method: RequestMethod.PATCH,
    path: ':ref/team/:memberId',
    status: DEFAULT_STATUS,
  },
  {
    handler: 'remove',
    method: RequestMethod.DELETE,
    path: ':ref/team/:memberId',
    status: 204,
  },
];

const linkRoutes: RouteRow[] = [
  {
    handler: 'list',
    method: RequestMethod.GET,
    path: ':id/team-links',
    status: DEFAULT_STATUS,
  },
  {
    handler: 'searchCandidates',
    method: RequestMethod.GET,
    path: ':id/team-links/candidates',
    status: DEFAULT_STATUS,
  },
  {
    handler: 'request',
    method: RequestMethod.POST,
    path: ':id/team-links/requests',
    status: 201,
  },
  {
    handler: 'accept',
    method: RequestMethod.POST,
    path: ':id/team-links/:linkId/accept',
    status: 200,
  },
  {
    handler: 'decline',
    method: RequestMethod.POST,
    path: ':id/team-links/:linkId/decline',
    status: 204,
  },
  {
    handler: 'cancel',
    method: RequestMethod.POST,
    path: ':id/team-links/:linkId/cancel',
    status: 204,
  },
  {
    handler: 'leave',
    method: RequestMethod.DELETE,
    path: ':id/team-links/:linkId',
    status: 204,
  },
];

const controllerTables: Array<[string, ControllerClass, RouteRow[]]> = [
  ['ListingTeamController', ListingTeamController, teamRoutes],
  ['ListingTeamLinksController', ListingTeamLinksController, linkRoutes],
];

const methodOrderOf = (controller: ControllerClass): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter(
    (name) => name !== 'constructor',
  );

describe('Listing team controllers', () => {
  it('gates both controllers on active members and the listings feature', () => {
    for (const [, controller] of controllerTables) {
      expect(guardsOf(controller)).toEqual([ActiveMemberGuard]);
      expect(Reflect.getMetadata(FEATURE_KEY, controller)).toBe('listings');
    }
    expect(Reflect.getMetadata(PATH_METADATA, ListingTeamController)).toBe(
      'listings',
    );
    expect(Reflect.getMetadata(PATH_METADATA, ListingTeamLinksController)).toBe(
      'subprofiles',
    );
  });

  it.each(controllerTables)(
    'declares every route of the contract with its method, path and status on %s',
    (_name, controller, routes) => {
      for (const route of routes) {
        const handler = handlerOf(controller, route.handler);
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(route.path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
          route.method,
        );
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
          route.status,
        );
      }
      expect(methodOrderOf(controller).sort()).toEqual(
        routes.map((route) => route.handler).sort(),
      );
    },
  );

  it('keeps restricted members out of invite, approve, edit, request and accept alone', () => {
    const guarded: Array<[ControllerClass, string[]]> = [
      [
        ListingTeamController,
        ['invite', 'inviteMember', 'approve', 'updateRoleLabel'],
      ],
      [ListingTeamLinksController, ['request', 'accept']],
    ];
    for (const [controller, expectedNames] of guarded) {
      const actualNames = methodOrderOf(controller).filter((name) =>
        guardsOf(handlerOf(controller, name)).includes(NotRestrictedGuard),
      );
      expect(actualNames.sort()).toEqual([...expectedNames].sort());
    }
  });

  it('throttles the searches at 30 and the invites and requests at 10 per minute', () => {
    const expectedLimits: Array<[ControllerClass, string, number]> = [
      [ListingTeamController, 'searchCandidates', 30],
      [ListingTeamController, 'invite', 10],
      [ListingTeamController, 'inviteMember', 10],
      [ListingTeamLinksController, 'searchCandidates', 30],
      [ListingTeamLinksController, 'request', 10],
    ];
    for (const [controller, handlerName, limit] of expectedLimits) {
      const handler = handlerOf(controller, handlerName);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBe(limit);
      expect(Reflect.getMetadata(THROTTLE_TTL_KEY, handler)).toBe(60_000);
    }
  });

  it('declares the literal segments before the member id', () => {
    const teamOrder = methodOrderOf(ListingTeamController);
    for (const literal of [
      'searchCandidates',
      'invite',
      'inviteMember',
      'reorder',
    ]) {
      expect(teamOrder.indexOf(literal)).toBeLessThan(
        teamOrder.indexOf('approve'),
      );
    }
    const linkOrder = methodOrderOf(ListingTeamLinksController);
    for (const literal of ['searchCandidates', 'request']) {
      expect(linkOrder.indexOf(literal)).toBeLessThan(
        linkOrder.indexOf('accept'),
      );
    }
  });

  it('registers the team controller before the listings controller and the three providers', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ListingsModule,
    ) as unknown[];
    expect(controllers.indexOf(ListingTeamController)).toBeGreaterThanOrEqual(
      0,
    );
    expect(controllers.indexOf(ListingTeamController)).toBeLessThan(
      controllers.indexOf(ListingsController),
    );
    expect(controllers).toContain(ListingTeamLinksController);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ListingsModule),
    ).toEqual(
      expect.arrayContaining([
        ListingTeamService,
        ListingTeamLinksService,
        ListingTeamAlertsListener,
      ]),
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, ListingsModule),
    ).toContain(SubprofilesModule);
  });

  it('forwards the caller and the parsed ids to the services', async () => {
    const user = { userId: 'user-1' } as CurrentUserData;
    const teamService = {
      listForManager: jest.fn().mockResolvedValue('list'),
      searchCandidates: jest.fn().mockResolvedValue('search'),
      invite: jest.fn().mockResolvedValue('invite'),
      inviteMember: jest.fn().mockResolvedValue('inviteMember'),
      reorder: jest.fn().mockResolvedValue('reorder'),
      approve: jest.fn().mockResolvedValue('approve'),
      decline: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
      updateRoleLabel: jest.fn().mockResolvedValue('label'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const teamController = new ListingTeamController(
      teamService as unknown as ListingTeamService,
    );
    const inviteBody = { subprofileId: 'persona-1' };
    const memberInviteBody = { memberSlug: 'ana-silva', roleLabel: 'Chef' };
    const approveBody = { roleLabel: 'Chef' };
    const labelBody = { roleLabel: null };
    const orderBody = { memberIds: ['member-1'] };

    await teamController.list(user, 'ref-1');
    await teamController.searchCandidates(user, 'ref-1', { q: 'ana' });
    await teamController.invite(user, 'ref-1', inviteBody);
    await teamController.inviteMember(user, 'ref-1', memberInviteBody);
    await teamController.reorder(user, 'ref-1', orderBody);
    await teamController.approve(user, 'ref-1', 'member-1', approveBody);
    await teamController.decline(user, 'ref-1', 'member-1');
    await teamController.cancel(user, 'ref-1', 'member-1');
    await teamController.updateRoleLabel(user, 'ref-1', 'member-1', labelBody);
    await teamController.remove(user, 'ref-1', 'member-1');

    expect(teamService.listForManager).toHaveBeenCalledWith('ref-1', 'user-1');
    expect(teamService.searchCandidates).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      'ana',
    );
    expect(teamService.invite).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      inviteBody,
    );
    expect(teamService.inviteMember).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      memberInviteBody,
    );
    expect(teamService.reorder).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      orderBody,
    );
    expect(teamService.approve).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      'member-1',
      approveBody,
    );
    expect(teamService.decline).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      'member-1',
    );
    expect(teamService.cancel).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      'member-1',
    );
    expect(teamService.updateRoleLabel).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      'member-1',
      labelBody,
    );
    expect(teamService.remove).toHaveBeenCalledWith(
      'ref-1',
      'user-1',
      'member-1',
    );

    const linksService = {
      listForPersona: jest.fn().mockResolvedValue('list'),
      searchCandidates: jest.fn().mockResolvedValue('search'),
      request: jest.fn().mockResolvedValue('request'),
      accept: jest.fn().mockResolvedValue('accept'),
      decline: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
    };
    const linksController = new ListingTeamLinksController(
      linksService as unknown as ListingTeamLinksService,
    );
    const requestBody = { listingId: 'listing-1' };

    await linksController.list(user, 'persona-1');
    await linksController.searchCandidates(user, 'persona-1', { q: 'cafe' });
    await linksController.request(user, 'persona-1', requestBody);
    await linksController.accept(user, 'persona-1', 'link-1');
    await linksController.decline(user, 'persona-1', 'link-1');
    await linksController.cancel(user, 'persona-1', 'link-1');
    await linksController.leave(user, 'persona-1', 'link-1');

    expect(linksService.listForPersona).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
    );
    expect(linksService.searchCandidates).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
      'cafe',
    );
    expect(linksService.request).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
      requestBody,
    );
    expect(linksService.accept).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
      'link-1',
    );
    expect(linksService.decline).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
      'link-1',
    );
    expect(linksService.cancel).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
      'link-1',
    );
    expect(linksService.leave).toHaveBeenCalledWith(
      'persona-1',
      'user-1',
      'link-1',
    );
  });
});
