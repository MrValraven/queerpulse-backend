import { HttpException, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminVjLiveController } from './admin-vj-live.controller';
import { VJ_REFUSALS } from './vj.constants';
import type { VjGateway, VjLiveStopOutcome } from './vj.gateway';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';

const EXPECTED_ROUTES = [
  ['listLive', RequestMethod.GET, '/'],
  ['stopEverything', RequestMethod.POST, 'stop'],
  ['stopConnection', RequestMethod.POST, 'connections/:connectionId/stop'],
] as const;

type HandlerFunction = (...args: unknown[]) => unknown;

function handlerOf(handlerName: string): HandlerFunction {
  const handler = (
    AdminVjLiveController.prototype as unknown as Record<
      string,
      HandlerFunction | undefined
    >
  )[handlerName];
  if (!handler) {
    throw new Error(`No handler named ${handlerName} on the controller`);
  }
  return handler;
}

function userOf(userId: string, role: UserRole): CurrentUserData {
  return { userId, email: `${userId}@example.com`, status: 'active', role };
}

function createController() {
  const gateway = {
    listLiveConnections: jest
      .fn()
      .mockResolvedValue({ stages: [], idleStageCount: 0 }),
    stopEverything: jest
      .fn()
      .mockReturnValue({ stoppedScreenCount: 2, stoppedRemoteCount: 1 }),
    stopLiveConnection: jest.fn<VjLiveStopOutcome, [unknown, string]>(),
  };
  const controller = new AdminVjLiveController(gateway as unknown as VjGateway);
  return { controller, gateway };
}

describe('AdminVjLiveController access', () => {
  const reflector = new Reflector();

  it('declares the three routes under admin/vj/live behind the VJ library gate', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminVjLiveController)).toBe(
      'admin/vj/live',
    );
    for (const [handlerName, method, path] of EXPECTED_ROUTES) {
      expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(handlerName))).toBe(
        method,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handlerOf(handlerName))).toBe(
        path,
      );
    }
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminVjLiveController)).toEqual(
      [ActiveMemberGuard, RolesOrStaffGuard],
    );
    expect(reflector.get(ROLES_KEY, AdminVjLiveController)).toEqual([
      UserRole.Admin,
    ]);
    expect(reflector.get(STAFF_ROLES_KEY, AdminVjLiveController)).toEqual([
      'vj_operator',
    ]);
  });

  it('answers the list with no-store and the stops with 200', () => {
    expect(
      Reflect.getMetadata(HEADERS_METADATA, handlerOf('listLive')),
    ).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    for (const handlerName of ['stopEverything', 'stopConnection']) {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(handlerName)),
      ).toBe(HttpStatus.OK);
    }
  });
});

describe('AdminVjLiveController scope', () => {
  it('lists every stage for an Admin', async () => {
    const { controller, gateway } = createController();
    await controller.listLive(userOf(ADMIN_ID, UserRole.Admin));
    expect(gateway.listLiveConnections).toHaveBeenCalledWith({
      callerUserId: ADMIN_ID,
      isAdmin: true,
    });
  });

  it.each([UserRole.Member, UserRole.Moderator])(
    'lists only the own stage for a %s let in by the vj_operator grant',
    async (role) => {
      const { controller, gateway } = createController();
      await controller.listLive(userOf(OPERATOR_ID, role));
      expect(gateway.listLiveConnections).toHaveBeenCalledWith({
        callerUserId: OPERATOR_ID,
        isAdmin: false,
      });
    },
  );

  it('stops everything in the caller scope and answers the counts', () => {
    const { controller, gateway } = createController();
    expect(
      controller.stopEverything(userOf(OPERATOR_ID, UserRole.Member)),
    ).toEqual({ stoppedScreenCount: 2, stoppedRemoteCount: 1 });
    expect(gateway.stopEverything).toHaveBeenCalledWith({
      callerUserId: OPERATOR_ID,
      isAdmin: false,
    });
  });
});

describe('AdminVjLiveController single stop', () => {
  it('answers the counts of a stopped connection', () => {
    const { controller, gateway } = createController();
    gateway.stopLiveConnection.mockReturnValue({
      refusal: null,
      stopped: { stoppedScreenCount: 1, stoppedRemoteCount: 0 },
    });

    expect(
      controller.stopConnection(userOf(ADMIN_ID, UserRole.Admin), 'socket-a'),
    ).toEqual({ stoppedScreenCount: 1, stoppedRemoteCount: 0 });
    expect(gateway.stopLiveConnection).toHaveBeenCalledWith(
      { callerUserId: ADMIN_ID, isAdmin: true },
      'socket-a',
    );
  });

  it.each([
    ['VJ_CONNECTION_NOT_FOUND', HttpStatus.NOT_FOUND],
    ['VJ_CONNECTION_NOT_YOURS', HttpStatus.FORBIDDEN],
  ] as const)('throws %s with status %i', (code, status) => {
    const { controller, gateway } = createController();
    gateway.stopLiveConnection.mockReturnValue({
      refusal: code,
      stopped: null,
    });

    let thrown: unknown = null;
    try {
      controller.stopConnection(
        userOf(OPERATOR_ID, UserRole.Member),
        'socket-a',
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toEqual({
      statusCode: status,
      message: VJ_REFUSALS[code].message,
      code,
    });
  });
});
