import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Namespace } from 'socket.io';
import type { Repository } from 'typeorm';
import type { RefreshToken } from '../auth/entities/refresh-token.entity';
import type { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import type { UserStaffRole } from '../users/entities/user-staff-role.entity';
import type { User } from '../users/entities/user.entity';
import { VJ_STOPPED_MESSAGE } from './vj.constants';
import { VjGateway, vjRemotesRoomName, type VjLiveScope } from './vj.gateway';
import type { VjStageReadsService } from './vj-stage-reads.service';
import { VjStageService } from './vj-stage.service';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR_USER_ID = '99999999-9999-4999-8999-999999999999';
const FIRST_SCREEN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_SCREEN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OPERATOR_SCREEN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const START = Date.UTC(2026, 10, 9, 22, 0, 0);

const ADMIN_SCOPE: VjLiveScope = { callerUserId: ADMIN_USER_ID, isAdmin: true };
const OPERATOR_SCOPE: VjLiveScope = {
  callerUserId: OPERATOR_USER_ID,
  isAdmin: false,
};

type GatewayClient = Parameters<VjGateway['handleDisconnect']>[0];

interface FakeSocket {
  id: string;
  connected: boolean;
  handshake: { issued: number };
  data: Record<string, unknown>;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

interface RoomEmit {
  room: string;
  event: string;
}

function createHarness() {
  const sockets = new Map<string, FakeSocket>();
  const roomEmits: RoomEmit[] = [];
  const namespace = {
    sockets,
    to: (room: string) => ({
      emit: (event: string) => {
        roomEmits.push({ room, event });
        return true;
      },
    }),
  } as unknown as Namespace;
  const profileFind = jest.fn((_entity: unknown, options: unknown) => {
    const userIds = (options as { where: { userId: { value: string[] } } })
      .where.userId.value;
    const names: Record<string, [string, string]> = {
      [ADMIN_USER_ID]: ['Tiago', 'Costa'],
      [OPERATOR_USER_ID]: ['Bea', ''],
    };
    return Promise.resolve(
      userIds
        .filter((userId) => names[userId] !== undefined)
        .map((userId) => ({
          userId,
          firstName: names[userId]?.[0] ?? '',
          lastName: names[userId]?.[1] ?? '',
        })),
    );
  });
  const users = { manager: { find: profileFind } };
  const reads = {};
  const stages = new VjStageService(reads as unknown as VjStageReadsService);
  const gateway = new VjGateway(
    {} as unknown as JwtService,
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
    stages,
    reads as unknown as VjStageReadsService,
    users as unknown as Repository<User>,
    {} as unknown as Repository<RefreshToken>,
    {} as unknown as Repository<UserStaffRole>,
    {} as unknown as PlatformSettingsService,
  );
  gateway.namespace = namespace;
  gateway.afterInit();
  return { gateway, stages, sockets, roomEmits, profileFind };
}

type Harness = ReturnType<typeof createHarness>;

/** A live socket in the namespace whose drop runs the gateway's disconnect path. */
function addSocket(
  harness: Harness,
  socketId: string,
  data: Record<string, unknown>,
): FakeSocket {
  const socket: FakeSocket = {
    id: socketId,
    connected: true,
    handshake: { issued: START },
    data,
    emit: jest.fn(),
    disconnect: jest.fn(() => {
      socket.connected = false;
      harness.sockets.delete(socketId);
      harness.gateway.handleDisconnect(socket as unknown as GatewayClient);
    }),
  };
  harness.sockets.set(socketId, socket);
  return socket;
}

function addScreen(
  harness: Harness,
  ownerUserId: string,
  socketId: string,
  screenId: string,
  now: number,
): FakeSocket {
  const outcome = harness.stages.attachScreen(
    {
      adminUserId: ownerUserId,
      socketId,
      screenId,
      restoreState: null,
      restoreReads: null,
    },
    now,
  );
  expect(outcome.ok).toBe(true);
  return addSocket(harness, socketId, {
    userId: ownerUserId,
    role: 'screen',
    isAttached: true,
    screenId,
  });
}

function addRemote(
  harness: Harness,
  ownerUserId: string,
  socketId: string,
  now: number,
): FakeSocket {
  harness.stages.attachRemote(ownerUserId, socketId, now);
  return addSocket(harness, socketId, {
    userId: ownerUserId,
    role: 'remote',
    isAttached: true,
    attachedAt: now,
  });
}

function stoppedFrame() {
  return {
    status: 'error',
    code: 'BAD_REQUEST',
    message: VJ_STOPPED_MESSAGE,
    domainCode: 'vj_stopped',
  };
}

/** A live socket whose handshake is still running: its admission resolves
 *  when the test calls `admitAs` (setting the user id first, as `admit` does)
 *  or `refuse`. */
function addAdmittingSocket(harness: Harness, socketId: string) {
  let resolveAdmission: (userId: string | null) => void = () => undefined;
  const admission = new Promise<string | null>((resolve) => {
    resolveAdmission = resolve;
  });
  const socket = addSocket(harness, socketId, { admission });
  return {
    socket,
    admission,
    admitAs: (userId: string): Promise<string | null> => {
      socket.data.userId = userId;
      resolveAdmission(userId);
      return admission;
    },
    refuse: (): Promise<string | null> => {
      resolveAdmission(null);
      return admission;
    },
  };
}

describe('VjGateway live connections list', () => {
  it('answers nothing connected and reads no profile when no stage is in memory', async () => {
    const harness = createHarness();
    expect(await harness.gateway.listLiveConnections(ADMIN_SCOPE)).toEqual({
      stages: [],
      idleStageCount: 0,
    });
    expect(harness.profileFind).not.toHaveBeenCalled();
  });

  it('lists every stage for an Admin, own stage first, with the owner names in one read', async () => {
    const harness = createHarness();
    addScreen(
      harness,
      ADMIN_USER_ID,
      'admin-screen-first',
      SECOND_SCREEN_ID,
      START,
    );
    addScreen(
      harness,
      ADMIN_USER_ID,
      'admin-screen-second',
      FIRST_SCREEN_ID,
      START,
    );
    addRemote(harness, ADMIN_USER_ID, 'admin-remote', START + 50);
    addRemote(harness, OPERATOR_USER_ID, 'operator-remote', START + 10);

    const live = await harness.gateway.listLiveConnections(ADMIN_SCOPE);

    expect(harness.profileFind).toHaveBeenCalledTimes(1);
    expect(live.idleStageCount).toBe(0);
    expect(live.stages.map((stage) => stage.owner)).toEqual([
      { userId: ADMIN_USER_ID, displayName: 'Tiago Costa' },
      { userId: OPERATOR_USER_ID, displayName: 'Bea' },
    ]);
    expect(live.stages[0]?.isOwnStage).toBe(true);
    expect(live.stages[1]?.isOwnStage).toBe(false);
    expect(
      live.stages[0]?.connections.map((connection) => [
        connection.connectionId,
        connection.role,
        connection.screenNumber,
        connection.isLead,
      ]),
    ).toEqual([
      ['admin-screen-first', 'screen', 1, true],
      ['admin-screen-second', 'screen', 2, false],
      ['admin-remote', 'remote', null, false],
    ]);
    expect(live.stages[0]?.connections[2]?.connectedAt).toBe(
      new Date(START + 50).toISOString(),
    );
  });

  it('lists only the own stage for a caller let in by the grant', async () => {
    const harness = createHarness();
    addRemote(harness, ADMIN_USER_ID, 'admin-remote', START);
    addScreen(
      harness,
      OPERATOR_USER_ID,
      'operator-screen',
      OPERATOR_SCREEN_ID,
      START,
    );

    const live = await harness.gateway.listLiveConnections(OPERATOR_SCOPE);

    expect(live.stages).toHaveLength(1);
    expect(live.stages[0]?.owner.userId).toBe(OPERATOR_USER_ID);
    expect(live.stages[0]?.isOwnStage).toBe(true);
    expect(
      live.stages[0]?.connections.map((connection) => connection.connectionId),
    ).toEqual(['operator-screen']);
  });

  it('counts a stage held in memory with nothing attached as idle', async () => {
    const harness = createHarness();
    const remote = addRemote(harness, ADMIN_USER_ID, 'admin-remote', START);
    remote.disconnect();

    expect(await harness.gateway.listLiveConnections(ADMIN_SCOPE)).toEqual({
      stages: [],
      idleStageCount: 1,
    });
  });

  it('reads the idle count with the snapshots, before the profiles read awaits', async () => {
    const harness = createHarness();
    addRemote(harness, ADMIN_USER_ID, 'admin-remote', START);
    const operatorRemote = addRemote(
      harness,
      OPERATOR_USER_ID,
      'operator-remote',
      START,
    );
    const readProfiles = harness.profileFind.getMockImplementation();
    harness.profileFind.mockImplementationOnce(
      (entity: unknown, options: unknown) => {
        operatorRemote.disconnect();
        return readProfiles?.(entity, options) ?? Promise.resolve([]);
      },
    );

    const live = await harness.gateway.listLiveConnections(ADMIN_SCOPE);

    expect(live.idleStageCount).toBe(0);
    expect(live.stages.map((stage) => stage.owner.userId)).toEqual([
      ADMIN_USER_ID,
      OPERATOR_USER_ID,
    ]);
  });
});

describe('VjGateway single stop', () => {
  it('sends vj_stopped, drops the socket and promotes the next lead', () => {
    const harness = createHarness();
    const lead = addScreen(
      harness,
      ADMIN_USER_ID,
      'screen-lead',
      FIRST_SCREEN_ID,
      START,
    );
    const follower = addScreen(
      harness,
      ADMIN_USER_ID,
      'screen-follow',
      SECOND_SCREEN_ID,
      START + 1,
    );

    const outcome = harness.gateway.stopLiveConnection(
      ADMIN_SCOPE,
      'screen-lead',
    );

    expect(outcome).toEqual({
      refusal: null,
      stopped: { stoppedScreenCount: 1, stoppedRemoteCount: 0 },
    });
    expect(lead.emit).toHaveBeenCalledWith('exception', stoppedFrame());
    expect(lead.disconnect).toHaveBeenCalledWith(true);
    expect(follower.disconnect).not.toHaveBeenCalled();
    expect(harness.stages.leadSocketIdOf(ADMIN_USER_ID)).toBe('screen-follow');
  });

  it('counts a stopped remote as a remote', () => {
    const harness = createHarness();
    addRemote(harness, OPERATOR_USER_ID, 'operator-remote', START);
    expect(
      harness.gateway.stopLiveConnection(OPERATOR_SCOPE, 'operator-remote'),
    ).toEqual({
      refusal: null,
      stopped: { stoppedScreenCount: 0, stoppedRemoteCount: 1 },
    });
  });

  it('answers VJ_CONNECTION_NOT_FOUND for a socket id that is gone', () => {
    const harness = createHarness();
    expect(
      harness.gateway.stopLiveConnection(ADMIN_SCOPE, 'socket-gone'),
    ).toEqual({ refusal: 'VJ_CONNECTION_NOT_FOUND', stopped: null });
  });

  it('answers VJ_CONNECTION_NOT_FOUND for a socket still waiting on its handshake', () => {
    const harness = createHarness();
    const pending = addSocket(harness, 'socket-pending', {});
    expect(
      harness.gateway.stopLiveConnection(ADMIN_SCOPE, 'socket-pending'),
    ).toEqual({ refusal: 'VJ_CONNECTION_NOT_FOUND', stopped: null });
    expect(pending.disconnect).not.toHaveBeenCalled();
  });

  it('answers VJ_CONNECTION_NOT_YOURS when an operator names another owner socket', () => {
    const harness = createHarness();
    const adminRemote = addRemote(
      harness,
      ADMIN_USER_ID,
      'admin-remote',
      START,
    );

    expect(
      harness.gateway.stopLiveConnection(OPERATOR_SCOPE, 'admin-remote'),
    ).toEqual({ refusal: 'VJ_CONNECTION_NOT_YOURS', stopped: null });
    expect(adminRemote.emit).not.toHaveBeenCalled();
    expect(adminRemote.disconnect).not.toHaveBeenCalled();
  });

  it('lets an Admin stop an operator connection', () => {
    const harness = createHarness();
    addRemote(harness, OPERATOR_USER_ID, 'operator-remote', START);
    expect(
      harness.gateway.stopLiveConnection(ADMIN_SCOPE, 'operator-remote')
        .refusal,
    ).toBeNull();
  });
});

describe('VjGateway stop everything', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops every socket for an Admin, attached or not, and drops every stage', () => {
    const harness = createHarness();
    const screen = addScreen(
      harness,
      ADMIN_USER_ID,
      'admin-screen',
      FIRST_SCREEN_ID,
      START,
    );
    const remote = addRemote(
      harness,
      OPERATOR_USER_ID,
      'operator-remote',
      START,
    );
    const unattached = addSocket(harness, 'operator-unattached', {
      userId: OPERATOR_USER_ID,
    });
    harness.stages.attachRemote(OPERATOR_USER_ID, 'gone-remote', START);
    harness.stages.detachSocket(OPERATOR_USER_ID, 'gone-remote', START);

    const stopped = harness.gateway.stopEverything(ADMIN_SCOPE);

    expect(stopped).toEqual({ stoppedScreenCount: 1, stoppedRemoteCount: 1 });
    for (const socket of [screen, remote, unattached]) {
      expect(socket.emit).toHaveBeenCalledWith('exception', stoppedFrame());
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    }
    expect(harness.stages.liveStages(null)).toEqual([]);
    expect(harness.stages.getState(ADMIN_USER_ID)).toBeNull();
    expect(harness.stages.getState(OPERATOR_USER_ID)).toBeNull();
  });

  it('stops only the own sockets and stage for a caller let in by the grant', () => {
    const harness = createHarness();
    const adminScreen = addScreen(
      harness,
      ADMIN_USER_ID,
      'admin-screen',
      FIRST_SCREEN_ID,
      START,
    );
    const operatorScreen = addScreen(
      harness,
      OPERATOR_USER_ID,
      'operator-screen',
      OPERATOR_SCREEN_ID,
      START,
    );

    const stopped = harness.gateway.stopEverything(OPERATOR_SCOPE);

    expect(stopped).toEqual({ stoppedScreenCount: 1, stoppedRemoteCount: 0 });
    expect(operatorScreen.disconnect).toHaveBeenCalledWith(true);
    expect(adminScreen.emit).not.toHaveBeenCalled();
    expect(adminScreen.disconnect).not.toHaveBeenCalled();
    expect(harness.stages.getState(OPERATOR_USER_ID)).toBeNull();
    expect(harness.stages.getState(ADMIN_USER_ID)).not.toBeNull();
  });

  it('drops an idle stage with no socket left', () => {
    const harness = createHarness();
    harness.stages.attachRemote(OPERATOR_USER_ID, 'gone-remote', START);
    harness.stages.detachSocket(OPERATOR_USER_ID, 'gone-remote', START);

    expect(harness.gateway.stopEverything(OPERATOR_SCOPE)).toEqual({
      stoppedScreenCount: 0,
      stoppedRemoteCount: 0,
    });
    expect(harness.stages.idleStageCount(null)).toBe(0);
  });

  it('clears the trailing screens:update the drops scheduled', () => {
    const harness = createHarness();
    addScreen(harness, ADMIN_USER_ID, 'admin-screen', FIRST_SCREEN_ID, START);
    addRemote(harness, ADMIN_USER_ID, 'admin-remote', START);

    harness.gateway.stopEverything(ADMIN_SCOPE);
    jest.advanceTimersByTime(1000);

    expect(
      harness.roomEmits.filter(
        (record) =>
          record.room === vjRemotesRoomName(ADMIN_USER_ID) &&
          record.event === 'screens:update',
      ),
    ).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops a socket admitted after the stop when it lands on the own stage, outside the counts', async () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'operator-admitting');

    const stopped = harness.gateway.stopEverything(OPERATOR_SCOPE);

    expect(stopped).toEqual({ stoppedScreenCount: 0, stoppedRemoteCount: 0 });
    expect(admitting.socket.disconnect).not.toHaveBeenCalled();

    await admitting.admitAs(OPERATOR_USER_ID);

    expect(admitting.socket.emit).toHaveBeenCalledWith(
      'exception',
      stoppedFrame(),
    );
    expect(admitting.socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('leaves a socket admitted onto another owner alone for a caller let in by the grant', async () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'admin-admitting');

    harness.gateway.stopEverything(OPERATOR_SCOPE);
    await admitting.admitAs(ADMIN_USER_ID);

    expect(admitting.socket.emit).not.toHaveBeenCalled();
    expect(admitting.socket.disconnect).not.toHaveBeenCalled();
  });

  it('sends nothing more to a socket whose handshake was refused', async () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'refused-admitting');

    harness.gateway.stopEverything(OPERATOR_SCOPE);
    await admitting.refuse();

    expect(admitting.socket.emit).not.toHaveBeenCalled();
    expect(admitting.socket.disconnect).not.toHaveBeenCalled();
  });

  it('skips a late stop for a socket that already disconnected', async () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'gone-admitting');

    harness.gateway.stopEverything(OPERATOR_SCOPE);
    admitting.socket.connected = false;
    harness.sockets.delete('gone-admitting');
    await admitting.admitAs(OPERATOR_USER_ID);

    expect(admitting.socket.emit).not.toHaveBeenCalled();
    expect(admitting.socket.disconnect).not.toHaveBeenCalled();
  });

  it('drops the stage again when the late socket attached and brought it back', async () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'operator-admitting');

    harness.gateway.stopEverything(OPERATOR_SCOPE);
    harness.stages.attachRemote(OPERATOR_USER_ID, 'operator-admitting', START);
    Object.assign(admitting.socket.data, {
      role: 'remote',
      isAttached: true,
      attachedAt: START,
    });
    await admitting.admitAs(OPERATOR_USER_ID);

    expect(admitting.socket.disconnect).toHaveBeenCalledWith(true);
    expect(harness.stages.getState(OPERATOR_USER_ID)).toBeNull();
    expect(harness.stages.idleStageCount(null)).toBe(0);
  });

  it('keeps a stage the late socket rejoined while another socket is still attached to it', async () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'operator-admitting');

    harness.gateway.stopEverything(OPERATOR_SCOPE);
    const laterRemote = addRemote(
      harness,
      OPERATOR_USER_ID,
      'operator-later-remote',
      START + 10,
    );
    harness.stages.attachRemote(OPERATOR_USER_ID, 'operator-admitting', START);
    Object.assign(admitting.socket.data, {
      role: 'remote',
      isAttached: true,
      attachedAt: START,
    });
    await admitting.admitAs(OPERATOR_USER_ID);

    expect(admitting.socket.disconnect).toHaveBeenCalledWith(true);
    expect(laterRemote.disconnect).not.toHaveBeenCalled();
    expect(harness.stages.getState(OPERATOR_USER_ID)).not.toBeNull();
  });

  it('stops a socket still in its handshake at once for an Admin', () => {
    const harness = createHarness();
    const admitting = addAdmittingSocket(harness, 'any-admitting');

    expect(harness.gateway.stopEverything(ADMIN_SCOPE)).toEqual({
      stoppedScreenCount: 0,
      stoppedRemoteCount: 0,
    });
    expect(admitting.socket.disconnect).toHaveBeenCalledWith(true);
  });
});
