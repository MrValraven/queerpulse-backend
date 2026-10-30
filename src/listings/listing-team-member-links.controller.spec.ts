import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { ListingTeamMemberAlertsListener } from './listing-team-member-alerts.listener';
import { ListingTeamMemberLinksController } from './listing-team-member-links.controller';
import { ListingTeamMemberLinksService } from './listing-team-member-links.service';
import { ListingTeamLinksController } from './listing-team-links.controller';
import { ListingsModule } from './listings.module';

const handlerOf = (methodName: string): object => {
  const handler = (
    ListingTeamMemberLinksController.prototype as unknown as Record<
      string,
      object | undefined
    >
  )[methodName];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];

const routes = [
  { handler: 'list', method: RequestMethod.GET, path: '/', status: undefined },
  {
    handler: 'accept',
    method: RequestMethod.POST,
    path: ':linkId/accept',
    status: 200,
  },
  {
    handler: 'decline',
    method: RequestMethod.POST,
    path: ':linkId/decline',
    status: 204,
  },
  {
    handler: 'leave',
    method: RequestMethod.DELETE,
    path: ':linkId',
    status: 204,
  },
];

describe('ListingTeamMemberLinksController', () => {
  it('sits on me/team-links behind the active member guard and the listings feature', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, ListingTeamMemberLinksController),
    ).toBe('me/team-links');
    expect(guardsOf(ListingTeamMemberLinksController)).toEqual([
      ActiveMemberGuard,
    ]);
    expect(
      Reflect.getMetadata(FEATURE_KEY, ListingTeamMemberLinksController),
    ).toBe('listings');
  });

  it('never shares a base path with the persona controller', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, ListingTeamMemberLinksController),
    ).not.toBe(Reflect.getMetadata(PATH_METADATA, ListingTeamLinksController));
  });

  it('declares every route of the contract with its method, path and status', () => {
    for (const route of routes) {
      const handler = handlerOf(route.handler);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(route.path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(route.method);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
        route.status,
      );
    }
    const declared = Object.getOwnPropertyNames(
      ListingTeamMemberLinksController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(declared.sort()).toEqual(
      routes.map((route) => route.handler).sort(),
    );
  });

  it('keeps restricted members out of accept alone', () => {
    const guarded = routes
      .map((route) => route.handler)
      .filter((name) => guardsOf(handlerOf(name)).includes(NotRestrictedGuard));
    expect(guarded).toEqual(['accept']);
  });

  it('parses the link id of every route as a UUID', () => {
    for (const name of ['accept', 'decline', 'leave']) {
      const argsMetadata = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        ListingTeamMemberLinksController,
        name,
      ) as Record<string, { data?: string; pipes: unknown[] }>;
      const linkIdArgument = Object.values(argsMetadata).find(
        (argument) => argument.data === 'linkId',
      );
      expect(linkIdArgument?.pipes).toContain(ParseUUIDPipe);
    }
  });

  it('delegates each route to the service with the caller and the link id', () => {
    const list = jest.fn().mockReturnValue('list');
    const accept = jest.fn().mockReturnValue('accept');
    const decline = jest.fn().mockReturnValue('decline');
    const leave = jest.fn().mockReturnValue('leave');
    const controller = new ListingTeamMemberLinksController({
      list,
      accept,
      decline,
      leave,
    } as unknown as ListingTeamMemberLinksService);
    const user = { userId: 'member-user-1' } as CurrentUserData;
    expect(controller.list(user)).toBe('list');
    expect(controller.accept(user, 'link-1')).toBe('accept');
    expect(controller.decline(user, 'link-1')).toBe('decline');
    expect(controller.leave(user, 'link-1')).toBe('leave');
    expect(list).toHaveBeenCalledWith('member-user-1');
    expect(accept).toHaveBeenCalledWith('member-user-1', 'link-1');
    expect(decline).toHaveBeenCalledWith('member-user-1', 'link-1');
    expect(leave).toHaveBeenCalledWith('member-user-1', 'link-1');
  });

  it('is registered in the listings module with its service and alerts listener', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ListingsModule),
    ).toContain(ListingTeamMemberLinksController);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ListingsModule),
    ).toEqual(
      expect.arrayContaining([
        ListingTeamMemberLinksService,
        ListingTeamMemberAlertsListener,
      ]),
    );
  });
});
