import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Namespace } from 'socket.io';
import type { Repository } from 'typeorm';
import type { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import type { VjAttachPayloadDto } from './dto/vj-socket-payloads';
import {
  VJ_NOT_ADMIN_MESSAGE,
  VJ_SCREEN_REPLACED_MESSAGE,
} from './vj.constants';
import {
  createVjStageState,
  type VjAck,
  type VjLibraryChange,
  type VjStageFrame,
  type VjStageRestore,
} from './vj.contract';
import {
  VJ_LIBRARY_ROOM,
  VJ_ROLE_RECHECK_MS,
  VjGateway,
  vjRemotesRoomName,
  vjStageRoomName,
} from './vj.gateway';
import type { VjLibraryService } from './vj-library.service';
import { VjStageService } from './vj-stage.service';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_ADMIN_USER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SCREEN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SCREEN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLIENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PACK_ID = '11111111-1111-4111-8111-111111111111';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const RESTORED_EPOCH = '33333333-3333-4333-8333-333333333333';
const START = Date.UTC(2026, 10, 5, 22, 0, 0);

type GatewayClient = Parameters<VjGateway['handleConnection']>[0];

interface FakeClient {
  id: string;
  connected: boolean;
  handshake: {
    auth: { token?: string };
    headers: Record<string, string | undefined>;
  };
  data: Record<string, unknown>;
  emit: jest.Mock;
  join: jest.Mock;
  disconnect: jest.Mock;
}

interface RoomEmit {
  room: string;
  event: string;
  payload: unknown;
}

interface Harness {
  gateway: VjGateway;
  stages: VjStageService;
  sockets: Map<string, FakeClient>;
  roomEmits: RoomEmit[];
  roleByUserId: Map<string, UserRole>;
  statusByUserId: Map<string, UserStatus>;
  users: { findOne: jest.Mock };
  refreshTokens: { exists: jest.Mock };
  jwt: { verifyAsync: jest.Mock };
  library: {
    packExists: jest.Mock;
    clipExists: jest.Mock;
    isClipInPack: jest.Mock;
  };
}

function createHarness(): Harness {
  const roomEmits: RoomEmit[] = [];
  const sockets = new Map<string, FakeClient>();
  const namespace = {
    sockets,
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        roomEmits.push({ room, event, payload });
        return true;
      },
    }),
    disconnectSockets: jest.fn(),
  } as unknown as Namespace;
  const roleByUserId = new Map<string, UserRole>([
    [ADMIN_USER_ID, UserRole.Admin],
    [MEMBER_USER_ID, UserRole.Member],
  ]);
  const statusByUserId = new Map<string, UserStatus>();
  const users = {
    findOne: jest.fn((options: { where: { id: string } }) =>
      Promise.resolve({
        id: options.where.id,
        role: roleByUserId.get(options.where.id) ?? UserRole.Member,
        status: statusByUserId.get(options.where.id) ?? UserStatus.Active,
      }),
    ),
  };
  const refreshTokens = { exists: jest.fn(() => Promise.resolve(true)) };
  const jwt = {
    verifyAsync: jest.fn((token: string) =>
      Promise.resolve({
        sub: token,
        status: UserStatus.Active,
        exp: Math.floor(Date.now() / 1000) + 900,
        sid: `family-${token}`,
      }),
    ),
  };
  const library = {
    packExists: jest.fn(() => Promise.resolve(true)),
    clipExists: jest.fn(() => Promise.resolve(true)),
    isClipInPack: jest.fn(() => Promise.resolve(true)),
  };
  const stages = new VjStageService();
  const gateway = new VjGateway(
    jwt as unknown as JwtService,
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
    stages,
    library as unknown as VjLibraryService,
    users as unknown as Repository<User>,
    refreshTokens as unknown as Repository<RefreshToken>,
  );
  gateway.namespace = namespace;
  gateway.afterInit();
  return {
    gateway,
    stages,
    sockets,
    roomEmits,
    roleByUserId,
    statusByUserId,
    users,
    refreshTokens,
    jwt,
    library,
  };
}

function makeClient(socketId: string, token: string | null): FakeClient {
  const client: FakeClient = {
    id: socketId,
    connected: true,
    handshake: { auth: token === null ? {} : { token }, headers: {} },
    data: {},
    emit: jest.fn(),
    join: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(),
  };
  return client;
}

function asClient(client: FakeClient): GatewayClient {
  return client as unknown as GatewayClient;
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function codeOf(ack: VjAck<object>): string | null {
  return ack.ok ? null : ack.code;
}

function clientEmits(client: FakeClient, event: string): unknown[] {
  return client.emit.mock.calls
    .filter((call: unknown[]) => call[0] === event)
    .map((call: unknown[]) => call[1]);
}

function roomEmitsOf(harness: Harness, event: string): RoomEmit[] {
  return harness.roomEmits.filter((record) => record.event === event);
}

function joinedRooms(client: FakeClient): unknown[] {
  return client.join.mock.calls.flatMap((call: unknown[]) => [call[0]].flat());
}

async function connect(
  harness: Harness,
  socketId: string,
  token: string | null = ADMIN_USER_ID,
): Promise<FakeClient> {
  const client = makeClient(socketId, token);
  harness.sockets.set(socketId, client);
  client.disconnect.mockImplementation(() => {
    client.connected = false;
    harness.sockets.delete(socketId);
  });
  await harness.gateway.handleConnection(asClient(client));
  return client;
}

function attachScreen(
  harness: Harness,
  client: FakeClient,
  screenId: string = SCREEN_ID,
  restoreState: VjStageRestore | null = null,
) {
  const payload: VjAttachPayloadDto = {
    role: 'screen',
    screenId,
    restoreState,
  };
  return harness.gateway.handleAttach(asClient(client), payload);
}

function attachRemote(harness: Harness, client: FakeClient) {
  return harness.gateway.handleAttach(asClient(client), { role: 'remote' });
}

async function attachedRemote(
  harness: Harness,
  socketId: string,
): Promise<FakeClient> {
  const client = await connect(harness, socketId);
  const ack = await attachRemote(harness, client);
  expect(ack.ok).toBe(true);
  return client;
}

async function attachedScreen(
  harness: Harness,
  socketId: string,
  screenId: string = SCREEN_ID,
): Promise<FakeClient> {
  const client = await connect(harness, socketId);
  const ack = await attachScreen(harness, client, screenId);
  expect(ack.ok).toBe(true);
  return client;
}

function setEffects(
  harness: Harness,
  client: FakeClient,
  commandSequence: number,
  isMirrored: boolean,
) {
  return harness.gateway.handleSetEffects(asClient(client), {
    clientId: CLIENT_ID,
    commandSequence,
    isMirrored,
  });
}

function setPack(
  harness: Harness,
  client: FakeClient,
  commandSequence: number,
  packId: string | null,
) {
  return harness.gateway.handleSetPack(asClient(client), {
    clientId: CLIENT_ID,
    commandSequence,
    packId,
  });
}

function sendStatus(
  harness: Harness,
  client: FakeClient,
  isFullscreen: boolean,
): Promise<void> {
  return harness.gateway.handleScreenStatus(asClient(client), {
    isFullscreen,
    preload: { packId: null, clips: [] },
  });
}

/** A restore naming PACK_ID and CLIP_ID from a stage the server lost. */
function buildRestoreState(): VjStageRestore {
  const base = createVjStageState(RESTORED_EPOCH, START - 60_000);
  return {
    stageEpoch: base.stageEpoch,
    revision: 7,
    activePackId: PACK_ID,
    liveClipId: CLIP_ID,
    transition: base.transition,
    overlay: base.overlay,
    effects: { ...base.effects, isMirrored: true },
    shuffle: base.shuffle,
  };
}

function stageFrames(harness: Harness): RoomEmit[] {
  return roomEmitsOf(harness, 'stage:state').filter(
    (record) => record.room === vjStageRoomName(ADMIN_USER_ID),
  );
}

describe('VjGateway', () => {
  let harness: Harness;

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    jest.setSystemTime(START);
    harness = createHarness();
  });

  afterEach(() => {
    harness.gateway.onModuleDestroy();
    harness.stages.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('handshake and reauth', () => {
    it('refuses a member handshake with FORBIDDEN vj_not_admin', async () => {
      const client = await connect(harness, 'socket-member', MEMBER_USER_ID);

      expect(clientEmits(client, 'exception')).toEqual([
        {
          status: 'error',
          code: 'FORBIDDEN',
          message: VJ_NOT_ADMIN_MESSAGE,
          domainCode: 'vj_not_admin',
        },
      ]);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
    });

    it('refuses a missing token, an inactive claim and an inactive row', async () => {
      const noToken = await connect(harness, 'socket-no-token', null);
      expect(clientEmits(noToken, 'exception')).toEqual([
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
      ]);
      expect(noToken.disconnect).toHaveBeenCalledWith(true);

      harness.jwt.verifyAsync.mockImplementationOnce((token: string) =>
        Promise.resolve({
          sub: token,
          status: UserStatus.Suspended,
          exp: Math.floor(Date.now() / 1000) + 900,
          sid: `family-${token}`,
        }),
      );
      const inactiveClaim = await connect(harness, 'socket-inactive-claim');
      expect(clientEmits(inactiveClaim, 'exception')).toEqual([
        expect.objectContaining({ code: 'SESSION_REVOKED' }),
      ]);
      expect(inactiveClaim.disconnect).toHaveBeenCalledWith(true);

      harness.statusByUserId.set(ADMIN_USER_ID, UserStatus.Suspended);
      const inactiveRow = await connect(harness, 'socket-inactive-row');
      expect(clientEmits(inactiveRow, 'exception')).toEqual([
        expect.objectContaining({ code: 'SESSION_REVOKED' }),
      ]);
      expect(inactiveRow.disconnect).toHaveBeenCalledWith(true);
    });

    it('meters the handshake on the verified user', async () => {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const client = await connect(harness, `socket-${attempt}`);
        expect(client.disconnect).not.toHaveBeenCalled();
      }
      const eleventh = await connect(harness, 'socket-11');

      expect(clientEmits(eleventh, 'exception')).toEqual([
        expect.objectContaining({ code: 'RATE_LIMITED' }),
      ]);
      expect(eleventh.disconnect).toHaveBeenCalledWith(true);
      // Metered before the row read: the refused attempt read no user.
      expect(harness.users.findOne).toHaveBeenCalledTimes(10);
    });

    it('drops the socket at the token expiry with TOKEN_EXPIRED', async () => {
      harness.jwt.verifyAsync.mockImplementationOnce((token: string) =>
        Promise.resolve({
          sub: token,
          status: UserStatus.Active,
          exp: Math.floor(Date.now() / 1000) + 60,
          sid: `family-${token}`,
        }),
      );
      const client = await connect(harness, 'socket-expiring');
      expect(client.data.userId).toBe(ADMIN_USER_ID);

      jest.advanceTimersByTime(59_999);
      expect(client.disconnect).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(clientEmits(client, 'exception')).toEqual([
        expect.objectContaining({ status: 'error', code: 'TOKEN_EXPIRED' }),
      ]);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('refuses a reauth for a demoted admin with FORBIDDEN and drops the socket', async () => {
      const client = await attachedRemote(harness, 'socket-remote');
      harness.roleByUserId.set(ADMIN_USER_ID, UserRole.Member);
      const { ticket } = socketTicketService.mint(
        ADMIN_USER_ID,
        `family-${ADMIN_USER_ID}`,
        UserStatus.Active,
        15 * 60_000,
      );

      const ack = await harness.gateway.handleReauth(asClient(client), {
        ticket,
      });

      expect(ack).toEqual({ ok: false, code: 'FORBIDDEN' });
      await flushImmediate();
      expect(clientEmits(client, 'exception')).toEqual([
        {
          status: 'error',
          code: 'FORBIDDEN',
          message: VJ_NOT_ADMIN_MESSAGE,
          domainCode: 'vj_not_admin',
        },
      ]);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('extends the expiry on a good reauth', async () => {
      harness.jwt.verifyAsync.mockImplementationOnce((token: string) =>
        Promise.resolve({
          sub: token,
          status: UserStatus.Active,
          exp: Math.floor(Date.now() / 1000) + 60,
          sid: `family-${token}`,
        }),
      );
      const client = await connect(harness, 'socket-reauth');
      const handshakeExp = client.data.exp as number;
      const { ticket } = socketTicketService.mint(
        ADMIN_USER_ID,
        `family-${ADMIN_USER_ID}`,
        UserStatus.Active,
        15 * 60_000,
      );

      const ack = await harness.gateway.handleReauth(asClient(client), {
        ticket,
      });

      expect(ack).toEqual({ ok: true, exp: expect.any(Number) as number });
      if (!ack.ok) return;
      expect(ack.exp).toBeGreaterThan(handshakeExp);
      expect(client.data.exp).toBe(ack.exp);
      jest.advanceTimersByTime(120_000);
      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('per-frame admin recheck', () => {
    it('rechecks the role at most once per five seconds per socket', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      // The handshake read covers the attach.
      expect(harness.users.findOne).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS + 1);
      expect((await setEffects(harness, remote, 1, true)).ok).toBe(true);
      expect(harness.users.findOne).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(2000);
      expect((await setEffects(harness, remote, 2, false)).ok).toBe(true);
      jest.advanceTimersByTime(2999);
      expect((await setEffects(harness, remote, 3, true)).ok).toBe(true);
      expect(harness.users.findOne).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(2);
      expect((await setEffects(harness, remote, 4, false)).ok).toBe(true);
      expect(harness.users.findOne).toHaveBeenCalledTimes(3);
    });

    it('acks vj_not_admin to a demoted admin and drops the socket after the ack', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      harness.roleByUserId.set(ADMIN_USER_ID, UserRole.Moderator);
      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS);

      const ack = await setEffects(harness, remote, 1, true);

      expect(ack).toEqual({
        ok: false,
        code: 'vj_not_admin',
        message: VJ_NOT_ADMIN_MESSAGE,
      });
      expect(remote.disconnect).not.toHaveBeenCalled();
      expect(clientEmits(remote, 'exception')).toEqual([]);

      await flushImmediate();
      expect(clientEmits(remote, 'exception')).toEqual([
        {
          status: 'error',
          code: 'FORBIDDEN',
          message: VJ_NOT_ADMIN_MESSAGE,
          domainCode: 'vj_not_admin',
        },
      ]);
      expect(remote.disconnect).toHaveBeenCalledWith(true);
      const emitOrders = remote.emit.mock.invocationCallOrder;
      const exceptionOrder = emitOrders[emitOrders.length - 1] ?? 0;
      const disconnectOrder =
        remote.disconnect.mock.invocationCallOrder[0] ?? 0;
      expect(exceptionOrder).toBeLessThan(disconnectOrder);
      // Nothing about the stage changed.
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);
    });

    it('acks vj_not_admin to a frame whose role read resolves after a FORBIDDEN reauth', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS);
      let resolveRoleRead: (row: {
        id: string;
        role: UserRole;
        status: UserStatus;
      }) => void = () => undefined;
      harness.users.findOne.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRoleRead = resolve;
          }),
      );

      const commandPending = setEffects(harness, remote, 1, true);
      await flushImmediate();
      expect(harness.users.findOne).toHaveBeenCalledTimes(2);

      harness.roleByUserId.set(ADMIN_USER_ID, UserRole.Member);
      const { ticket } = socketTicketService.mint(
        ADMIN_USER_ID,
        `family-${ADMIN_USER_ID}`,
        UserStatus.Active,
        15 * 60_000,
      );
      expect(
        await harness.gateway.handleReauth(asClient(remote), { ticket }),
      ).toEqual({ ok: false, code: 'FORBIDDEN' });

      // The read started before the demotion still finds an Admin.
      resolveRoleRead({
        id: ADMIN_USER_ID,
        role: UserRole.Admin,
        status: UserStatus.Active,
      });

      expect(codeOf(await commandPending)).toBe('vj_not_admin');
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);
      await flushImmediate();
      expect(clientEmits(remote, 'exception')).toHaveLength(1);
      expect(remote.disconnect).toHaveBeenCalledWith(true);
      expect(stageFrames(harness)).toEqual([]);
    });

    it('acks vj_server_error when the role read fails and logs the code only', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug');
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const remote = await attachedRemote(harness, 'socket-remote');
      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS);
      harness.users.findOne.mockRejectedValueOnce(
        new Error('read failed near SECRET-DB-DETAIL'),
      );

      const ack = await setEffects(harness, remote, 1, true);

      expect(codeOf(ack)).toBe('vj_server_error');
      await flushImmediate();
      expect(remote.disconnect).not.toHaveBeenCalled();
      const logged = [...debugSpy.mock.calls, ...errorSpy.mock.calls].map(
        (call) => call.map(String).join(' '),
      );
      expect(logged.some((line) => line.includes('vj_server_error'))).toBe(
        true,
      );
      expect(logged.some((line) => line.includes('SECRET-DB-DETAIL'))).toBe(
        false,
      );
    });
  });

  describe('attach', () => {
    it('attaches a screen, joins its rooms and sends state, role and the screen list', async () => {
      const screen = await connect(harness, 'socket-screen');

      const ack = await attachScreen(harness, screen);

      const state = harness.stages.getState(ADMIN_USER_ID);
      expect(state).not.toBeNull();
      expect(ack).toEqual({
        ok: true,
        role: 'screen',
        connectionExpiresAt: (screen.data.exp as number) * 1000,
        stageEpoch: state?.stageEpoch,
        isRestored: false,
        isLead: true,
      });
      expect(joinedRooms(screen)).toEqual(
        expect.arrayContaining([
          vjStageRoomName(ADMIN_USER_ID),
          VJ_LIBRARY_ROOM,
        ]) as unknown,
      );
      expect(joinedRooms(screen)).not.toContain(
        vjRemotesRoomName(ADMIN_USER_ID),
      );
      // Nothing leaves before the ack.
      expect(clientEmits(screen, 'stage:state')).toEqual([]);

      await flushImmediate();
      expect(clientEmits(screen, 'stage:state')).toEqual([
        {
          state: expect.objectContaining({
            stageEpoch: state?.stageEpoch,
          }) as unknown,
          cause: 'attach',
          sourceClientId: null,
        },
      ]);
      expect(clientEmits(screen, 'screen:role')).toEqual([{ isLead: true }]);
      expect(roomEmitsOf(harness, 'screens:update')).toEqual([]);

      jest.advanceTimersByTime(250);
      const updates = roomEmitsOf(harness, 'screens:update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.room).toBe(vjRemotesRoomName(ADMIN_USER_ID));
      expect(updates[0]?.payload).toEqual({
        screens: [
          expect.objectContaining({
            screenId: SCREEN_ID,
            number: 1,
            isLead: true,
          }),
        ],
      });
    });

    it('attaches a remote with the remotes room and its own screen list', async () => {
      const remote = await connect(harness, 'socket-remote');

      const ack = await attachRemote(harness, remote);

      expect(ack).toEqual({
        ok: true,
        role: 'remote',
        connectionExpiresAt: (remote.data.exp as number) * 1000,
        stageEpoch: harness.stages.getState(ADMIN_USER_ID)?.stageEpoch,
        isRestored: false,
        isLead: null,
      });
      expect(joinedRooms(remote)).toEqual(
        expect.arrayContaining([
          vjStageRoomName(ADMIN_USER_ID),
          vjRemotesRoomName(ADMIN_USER_ID),
          VJ_LIBRARY_ROOM,
        ]) as unknown,
      );

      await flushImmediate();
      expect(clientEmits(remote, 'stage:state')).toEqual([
        expect.objectContaining({ cause: 'attach', sourceClientId: null }),
      ]);
      expect(clientEmits(remote, 'screens:update')).toEqual([{ screens: [] }]);
    });

    it('answers vj_already_attached for a second attach', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');

      const second = await attachScreen(harness, remote);

      expect(codeOf(second)).toBe('vj_already_attached');
      expect(remote.data.role).toBe('remote');
    });

    it('answers vj_not_attached for a command before attach', async () => {
      const client = await connect(harness, 'socket-fresh');

      expect(codeOf(await setEffects(harness, client, 1, true))).toBe(
        'vj_not_attached',
      );
    });

    it('answers vj_wrong_role for a remote frame on a screen and a screen frame on a remote', async () => {
      const screen = await attachedScreen(harness, 'socket-screen');
      const remote = await attachedRemote(harness, 'socket-remote');

      expect(codeOf(await setEffects(harness, screen, 1, true))).toBe(
        'vj_wrong_role',
      );
      const advance = await harness.gateway.handleScreenAdvance(
        asClient(remote),
        { expectedClipSequence: 0, clipId: CLIP_ID },
      );
      expect(codeOf(advance)).toBe('vj_wrong_role');
    });

    it('broadcasts a restore to the whole stage', async () => {
      const base = createVjStageState(RESTORED_EPOCH, START - 60_000);
      const restoreState: VjStageRestore = {
        stageEpoch: base.stageEpoch,
        revision: 7,
        activePackId: PACK_ID,
        liveClipId: CLIP_ID,
        transition: base.transition,
        overlay: base.overlay,
        effects: { ...base.effects, isMirrored: true },
        shuffle: base.shuffle,
      };
      const screen = await connect(harness, 'socket-screen');

      const ack = await attachScreen(harness, screen, SCREEN_ID, restoreState);

      expect(ack).toMatchObject({ ok: true, isRestored: true, isLead: true });
      expect(harness.library.packExists).toHaveBeenCalledTimes(1);
      expect(harness.library.packExists).toHaveBeenCalledWith(PACK_ID);
      expect(harness.library.clipExists).toHaveBeenCalledTimes(1);
      expect(harness.library.clipExists).toHaveBeenCalledWith(CLIP_ID);

      await flushImmediate();
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = frames[0]?.payload as VjStageFrame;
      expect(frame.cause).toBe('restore');
      expect(frame.sourceClientId).toBeNull();
      expect(frame.state.activePackId).toBe(PACK_ID);
      expect(frame.state.liveClipId).toBe(CLIP_ID);
      expect(frame.state.revision).toBe(1);
      // The restore went to the room, so the screen got no private copy.
      expect(clientEmits(screen, 'stage:state')).toEqual([]);
    });

    it('answers vj_not_attached for a frame sent while a screen attach awaits its restore reads', async () => {
      let resolvePackRead: (isKnown: boolean) => void = () => undefined;
      harness.library.packExists.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePackRead = resolve;
          }),
      );
      const screen = await connect(harness, 'socket-screen');
      const attachPending = attachScreen(
        harness,
        screen,
        SCREEN_ID,
        buildRestoreState(),
      );
      await flushImmediate();
      expect(harness.library.packExists).toHaveBeenCalledTimes(1);

      const advance = await harness.gateway.handleScreenAdvance(
        asClient(screen),
        { expectedClipSequence: 0, clipId: CLIP_ID },
      );
      const command = await setEffects(harness, screen, 1, true);

      expect(codeOf(advance)).toBe('vj_not_attached');
      expect(codeOf(command)).toBe('vj_not_attached');
      expect(harness.library.isClipInPack).not.toHaveBeenCalled();

      resolvePackRead(true);
      expect(await attachPending).toMatchObject({
        ok: true,
        isRestored: true,
      });
      expect(screen.data.isAttached).toBe(true);
    });

    it('replaces an older socket with the same screen id', async () => {
      const older = await attachedScreen(harness, 'socket-older');

      const newer = await connect(harness, 'socket-newer');
      const ack = await attachScreen(harness, newer);

      expect(ack.ok).toBe(true);
      expect(clientEmits(older, 'exception')).toEqual([
        {
          status: 'error',
          code: 'BAD_REQUEST',
          message: VJ_SCREEN_REPLACED_MESSAGE,
          domainCode: 'vj_screen_replaced',
        },
      ]);
      expect(older.disconnect).toHaveBeenCalledWith(true);
      expect(newer.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('commands and screens', () => {
    it('broadcasts an applied command to the stage with its source client', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();

      const ack = await setEffects(harness, remote, 1, true);

      expect(ack).toEqual({ ok: true, revision: 1, isNoop: false });
      expect(stageFrames(harness)).toEqual([]);
      await flushImmediate();
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = frames[0]?.payload as VjStageFrame;
      expect(frame.cause).toBe('command');
      expect(frame.sourceClientId).toBe(CLIENT_ID);
      expect(frame.state.effects.isMirrored).toBe(true);
      expect(frame.state.revision).toBe(1);
    });

    it('applies a goClip awaiting its clip read before a later setTransition', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      let resolveClipRead: (isKnown: boolean) => void = () => undefined;
      harness.library.clipExists.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveClipRead = resolve;
          }),
      );

      const goClipPending = harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 5,
        clipId: CLIP_ID,
      });
      const transitionPending = harness.gateway.handleSetTransition(
        asClient(remote),
        { clientId: CLIENT_ID, commandSequence: 6, fadeMs: 1200 },
      );
      await flushImmediate();

      // The later command waits behind the earlier one's read.
      expect(harness.library.clipExists).toHaveBeenCalledTimes(1);
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);

      resolveClipRead(true);
      const goClipAck = await goClipPending;
      const transitionAck = await transitionPending;

      expect(goClipAck).toEqual({ ok: true, revision: 1, isNoop: false });
      expect(transitionAck).toEqual({ ok: true, revision: 2, isNoop: false });
      const state = harness.stages.getState(ADMIN_USER_ID);
      expect(state?.liveClipId).toBe(CLIP_ID);
      expect(state?.transition.fadeMs).toBe(1200);
    });

    it('refuses a frame past the bucket on arrival while earlier commands wait in the queue', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      let resolveClipRead: (isKnown: boolean) => void = () => undefined;
      harness.library.clipExists.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveClipRead = resolve;
          }),
      );

      const goClipPending = harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        clipId: CLIP_ID,
      });
      const queuedTransitions: Promise<VjAck<object>>[] = [];
      for (let sequence = 2; sequence <= 40; sequence += 1) {
        queuedTransitions.push(
          harness.gateway.handleSetTransition(asClient(remote), {
            clientId: CLIENT_ID,
            commandSequence: sequence,
            fadeMs: sequence * 10,
          }),
        );
      }

      // The 41st frame answers while the goClip read still holds the queue.
      const refused = await harness.gateway.handleSetTransition(
        asClient(remote),
        { clientId: CLIENT_ID, commandSequence: 41, fadeMs: 2000 },
      );
      expect(codeOf(refused)).toBe('vj_rate_limited');
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);

      resolveClipRead(true);
      expect(await goClipPending).toEqual({
        ok: true,
        revision: 1,
        isNoop: false,
      });
      const transitionAcks = await Promise.all(queuedTransitions);
      expect(transitionAcks.every((ack) => ack.ok)).toBe(true);
      const state = harness.stages.getState(ADMIN_USER_ID);
      expect(state?.revision).toBe(40);
      expect(state?.liveClipId).toBe(CLIP_ID);
      expect(state?.transition.fadeMs).toBe(400);
    });

    it('runs the next command after a command that failed', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      jest
        .spyOn(harness.stages, 'applyRemoteCommand')
        .mockImplementationOnce(() => {
          throw new Error('stage broke');
        });

      const failed = setEffects(harness, remote, 1, true);
      const next = setEffects(harness, remote, 2, true);

      expect(codeOf(await failed)).toBe('vj_server_error');
      expect(await next).toEqual({ ok: true, revision: 1, isNoop: false });
    });

    it('broadcasts nothing for a noop', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();

      const ack = await setEffects(harness, remote, 1, false);

      expect(ack).toEqual({ ok: true, revision: 0, isNoop: true });
      await flushImmediate();
      expect(stageFrames(harness)).toEqual([]);
    });

    it('answers vj_stale_command for a duplicate of a field-refused command', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      const refusedPayload = {
        clientId: CLIENT_ID,
        commandSequence: 1,
        speed: 3,
      };

      const refused = await harness.gateway.handleSetEffects(
        asClient(remote),
        refusedPayload,
      );
      const duplicate = await harness.gateway.handleSetEffects(
        asClient(remote),
        { ...refusedPayload },
      );

      expect(codeOf(refused)).toBe('vj_speed_invalid');
      expect(codeOf(duplicate)).toBe('vj_stale_command');
      expect(duplicate.ok ? undefined : duplicate.state).toEqual(
        harness.stages.getState(ADMIN_USER_ID),
      );
    });

    it('acks vj_server_error when the stage throws and logs the code only', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug');
      const remote = await attachedRemote(harness, 'socket-remote');
      jest
        .spyOn(harness.stages, 'applyRemoteCommand')
        .mockImplementation(() => {
          throw new Error('stage broke near SECRET-STAGE-DETAIL');
        });

      const ack = await setEffects(harness, remote, 1, true);

      expect(codeOf(ack)).toBe('vj_server_error');
      await flushImmediate();
      expect(stageFrames(harness)).toEqual([]);
      const logged = debugSpy.mock.calls.map((call) =>
        call.map(String).join(' '),
      );
      expect(logged.some((line) => line.includes('vj_server_error'))).toBe(
        true,
      );
      expect(logged.some((line) => line.includes('SECRET-STAGE-DETAIL'))).toBe(
        false,
      );
    });

    it("keeps a second admin's frames out of the first admin's stage", async () => {
      harness.roleByUserId.set(SECOND_ADMIN_USER_ID, UserRole.Admin);
      const firstRemote = await attachedRemote(harness, 'socket-first');
      const secondRemote = await connect(
        harness,
        'socket-second',
        SECOND_ADMIN_USER_ID,
      );
      expect((await attachRemote(harness, secondRemote)).ok).toBe(true);
      await flushImmediate();
      harness.roomEmits.length = 0;

      expect((await setEffects(harness, secondRemote, 1, true)).ok).toBe(true);
      await flushImmediate();

      expect(
        roomEmitsOf(harness, 'stage:state').map((record) => record.room),
      ).toEqual([vjStageRoomName(SECOND_ADMIN_USER_ID)]);
      expect(joinedRooms(secondRemote)).not.toContain(
        vjStageRoomName(ADMIN_USER_ID),
      );
      expect(joinedRooms(firstRemote)).not.toContain(
        vjStageRoomName(SECOND_ADMIN_USER_ID),
      );
      // The first remote holds only its own attach frame.
      expect(clientEmits(firstRemote, 'stage:state')).toHaveLength(1);
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);
      expect(harness.stages.getState(SECOND_ADMIN_USER_ID)?.revision).toBe(1);
    });

    it('reads the pack once for setPack and skips the read for a stale command', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');

      expect((await setPack(harness, remote, 1, PACK_ID)).ok).toBe(true);
      expect(harness.library.packExists).toHaveBeenCalledTimes(1);
      expect(harness.library.packExists).toHaveBeenCalledWith(PACK_ID);

      const stale = await setPack(harness, remote, 1, PACK_ID);

      expect(codeOf(stale)).toBe('vj_stale_command');
      expect(stale.ok ? undefined : stale.state?.activePackId).toBe(PACK_ID);
      expect(harness.library.packExists).toHaveBeenCalledTimes(1);
    });

    it('answers vj_pack_not_found when the pack read finds nothing', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      harness.library.packExists.mockResolvedValueOnce(false);

      expect(codeOf(await setPack(harness, remote, 1, PACK_ID))).toBe(
        'vj_pack_not_found',
      );
      expect(harness.stages.getState(ADMIN_USER_ID)?.activePackId).toBeNull();
    });

    it('refuses the 41st command in a burst with vj_rate_limited', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');

      for (let sequence = 1; sequence <= 40; sequence += 1) {
        const ack = await setEffects(
          harness,
          remote,
          sequence,
          sequence % 2 === 1,
        );
        expect(ack.ok).toBe(true);
      }

      expect(codeOf(await setEffects(harness, remote, 41, true))).toBe(
        'vj_rate_limited',
      );
    });

    it('answers vj_not_lead with the state for a follower advance', async () => {
      await attachedScreen(harness, 'socket-lead');
      jest.advanceTimersByTime(1000);
      const follower = await attachedScreen(
        harness,
        'socket-follower',
        OTHER_SCREEN_ID,
      );

      const ack = await harness.gateway.handleScreenAdvance(
        asClient(follower),
        { expectedClipSequence: 0, clipId: CLIP_ID },
      );

      expect(codeOf(ack)).toBe('vj_not_lead');
      expect(ack.ok ? undefined : ack.state).toEqual(
        harness.stages.getState(ADMIN_USER_ID),
      );
      expect(harness.library.isClipInPack).not.toHaveBeenCalled();
    });

    it('throttles screens:update to one frame per 250 ms per stage', async () => {
      const screen = await attachedScreen(harness, 'socket-screen');
      await flushImmediate();
      jest.advanceTimersByTime(250);
      harness.roomEmits.length = 0;

      await sendStatus(harness, screen, true);
      jest.advanceTimersByTime(40);
      await sendStatus(harness, screen, false);
      jest.advanceTimersByTime(40);
      await sendStatus(harness, screen, true);
      expect(roomEmitsOf(harness, 'screens:update')).toEqual([]);

      jest.advanceTimersByTime(250);
      const updates = roomEmitsOf(harness, 'screens:update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.room).toBe(vjRemotesRoomName(ADMIN_USER_ID));

      // Seven tokens are left (10, less three, plus a fraction refilled), so
      // five of twelve more frames are dropped before the stage sees them.
      const updateSpy = jest.spyOn(harness.stages, 'updateScreenStatus');
      const emitsBefore = screen.emit.mock.calls.length;
      for (let frame = 0; frame < 12; frame += 1) {
        await expect(
          sendStatus(harness, screen, frame % 2 === 0),
        ).resolves.toBeUndefined();
      }
      expect(updateSpy).toHaveBeenCalledTimes(7);
      expect(screen.emit.mock.calls.length).toBe(emitsBefore);
      expect(screen.disconnect).not.toHaveBeenCalled();
    });

    it('tells the promoted screen it leads when the lead disconnects', async () => {
      const lead = await attachedScreen(harness, 'socket-lead');
      jest.advanceTimersByTime(1000);
      const follower = await attachedScreen(
        harness,
        'socket-follower',
        OTHER_SCREEN_ID,
      );
      await flushImmediate();
      jest.advanceTimersByTime(250);
      harness.roomEmits.length = 0;

      lead.connected = false;
      harness.gateway.handleDisconnect(asClient(lead));

      expect(roomEmitsOf(harness, 'screen:role')).toEqual([
        { room: follower.id, event: 'screen:role', payload: { isLead: true } },
      ]);
      jest.advanceTimersByTime(250);
      expect(roomEmitsOf(harness, 'screens:update')).toHaveLength(1);
    });

    it('relays a library change and broadcasts the stage frames it causes', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      expect((await setPack(harness, remote, 1, PACK_ID)).ok).toBe(true);
      await flushImmediate();
      harness.roomEmits.length = 0;
      const change: VjLibraryChange = {
        kind: 'pack_deleted',
        packId: PACK_ID,
        clipId: null,
        packIds: [PACK_ID],
      };

      harness.gateway.handleLibraryChanged(change);

      expect(roomEmitsOf(harness, 'library:changed')).toEqual([
        { room: VJ_LIBRARY_ROOM, event: 'library:changed', payload: change },
      ]);
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = frames[0]?.payload as VjStageFrame;
      expect(frame.cause).toBe('library');
      expect(frame.sourceClientId).toBeNull();
      expect(frame.state.activePackId).toBeNull();
    });

    it('broadcasts the strobe timeout through the bound broadcaster', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      const ack = await harness.gateway.handleSetStrobe(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        isStrobing: true,
      });
      expect(ack.ok).toBe(true);
      await flushImmediate();
      harness.roomEmits.length = 0;

      jest.advanceTimersByTime(10_000);

      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = frames[0]?.payload as VjStageFrame;
      expect(frame.cause).toBe('strobe_timeout');
      expect(frame.state.effects.isStrobing).toBe(false);
      expect(frame.state.effects.strobeStartedAt).toBeNull();
    });

    it('never logs overlay text from a refused frame', async () => {
      const spies = (['log', 'debug', 'warn', 'error', 'verbose'] as const).map(
        (method) => jest.spyOn(Logger.prototype, method),
      );
      const remote = await attachedRemote(harness, 'socket-remote');

      await harness.gateway.handleSetOverlay(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        text: 'SECRET LINE\n',
        isVisible: true,
      });
      const refused = await harness.gateway.handleSetOverlay(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 2,
        text: 'SECRET LINE\nSECOND LINE',
        isVisible: true,
      });
      await flushImmediate();

      expect(codeOf(refused)).toBe('vj_overlay_text_invalid');
      const logged = spies.flatMap((spy) =>
        spy.mock.calls.map((call) => call.map(String).join(' ')),
      );
      expect(
        logged.some((line) => line.includes('vj_overlay_text_invalid')),
      ).toBe(true);
      expect(logged.some((line) => line.includes('SECRET LINE'))).toBe(false);
    });
  });
});
