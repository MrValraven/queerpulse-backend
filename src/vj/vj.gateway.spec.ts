import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Namespace } from 'socket.io';
import type { Repository } from 'typeorm';
import type { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import type { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import type { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import type { VjAttachPayloadDto } from './dto/vj-socket-payloads';
import {
  vjAckFailure,
  vjError,
  VJ_NOT_ADMIN_MESSAGE,
  VJ_SCREEN_REPLACED_MESSAGE,
} from './vj.constants';
import {
  createVjStageState,
  VJ_CONTRACT_VERSION,
  VJ_LIMITS,
  vjSceneLookOf,
  type VjAck,
  type VjLibraryChange,
  type VjSceneLook,
  type VjSetlistFollowRead,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjStageFrame,
  type VjStageRestore,
} from './vj.contract';
import {
  VJ_COMMAND_RATE_LIMIT,
  VJ_LIBRARY_ROOM,
  VJ_ROLE_RECHECK_MS,
  VjGateway,
  vjRemotesRoomName,
  vjStageRoomName,
} from './vj.gateway';
import type { VjSetlistService } from './vj-setlist.service';
import type { VjStageReadsService } from './vj-stage-reads.service';
import { VjStageService } from './vj-stage.service';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_ADMIN_USER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
/** A plain member holding the `vj_operator` grant. */
const OPERATOR_USER_ID = '99999999-9999-4999-8999-999999999999';
/** A plain member holding an unrelated grant. */
const MUSIC_PRODUCER_USER_ID = '12121212-1212-4121-8121-121212121212';
const SCREEN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SCREEN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLIENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PACK_ID = '11111111-1111-4111-8111-111111111111';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const RESTORED_EPOCH = '33333333-3333-4333-8333-333333333333';
const MIX_CLIP_ID = '44444444-4444-4444-8444-444444444444';
const EXCLUDED_CLIP_ID = '55555555-5555-4555-8555-555555555555';
const SETLIST_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_SETLIST_ID = '77777777-7777-4777-8777-777777777777';
const SCENE_ID = '88888888-8888-4888-8888-888888888888';
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

/** The seven contract 7.7 reads, each a jest mock: every pack and clip
 *  exists, nothing else does. */
function createReads() {
  return {
    readPackForStage: jest
      .fn<Promise<{ eventId: string | null } | null>, [string]>()
      .mockResolvedValue({ eventId: null }),
    existingClipIds: jest
      .fn<Promise<Set<string>>, [string[]]>()
      .mockImplementation((clipIds) => Promise.resolve(new Set(clipIds))),
    clipIdsInPack: jest
      .fn<Promise<Set<string>>, [string, string[]]>()
      .mockImplementation((_packId, clipIds) =>
        Promise.resolve(new Set(clipIds)),
      ),
    readPackClipForAdvance: jest
      .fn<Promise<{ isFavorite: boolean } | null>, [string, string]>()
      .mockResolvedValue({ isFavorite: false }),
    readSceneLook: jest
      .fn<Promise<VjSceneLook | null>, [string]>()
      .mockResolvedValue(null),
    readSetlist: jest
      .fn<Promise<VjSetlistRead | null>, [string, VjSetlistReadPosition]>()
      .mockResolvedValue(null),
    readSetlistFollow: jest
      .fn<Promise<VjSetlistFollowRead | null>, [string]>()
      .mockResolvedValue(null),
  };
}

/** The item ids of a test sequence of `stepCount` steps, in play order. */
function setlistItemIdsOf(stepCount: number): string[] {
  return Array.from(
    { length: stepCount },
    (_unused, index) =>
      `9${String(index).padStart(7, '0')}-0000-4000-8000-000000000000`,
  );
}

/** A read of SETLIST_ID with `stepCount` scene steps at a position, as
 *  VJ_STAGE_SETLIST_READ_SQL answers it. */
function setlistReadOf(
  stepCount: number,
  position: VjSetlistReadPosition,
  isLooping = false,
  look: VjSceneLook = vjSceneLookOf(createVjStageState(RESTORED_EPOCH, START)),
): VjSetlistRead {
  const itemIds = setlistItemIdsOf(stepCount);
  let index: number | null = null;
  if (position.kind === 'last') {
    index = stepCount > 0 ? stepCount - 1 : null;
  } else if (position.kind === 'index') {
    if (position.index < stepCount) {
      index = position.index;
    } else if (position.wrapsToFirst && stepCount > 0) {
      index = 0;
    }
  }
  const duration = { kind: 'seconds' as const, value: 8 };
  const itemId = index === null ? undefined : itemIds[index];
  return {
    setlistId: SETLIST_ID,
    isLooping,
    stepDuration: duration,
    itemIds,
    step:
      index === null || itemId === undefined
        ? null
        : {
            kind: 'scene',
            itemId,
            index,
            sceneId: SCENE_ID,
            look,
            duration,
          },
  };
}

/** Answers every SETLIST_ID read with a sequence of `stepCount` steps. */
function serveSetlistReads(
  reads: ReturnType<typeof createReads>,
  stepCount: number,
  isLooping = false,
  look?: VjSceneLook,
): void {
  reads.readSetlist.mockImplementation((setlistId, position) =>
    Promise.resolve(
      setlistId === SETLIST_ID
        ? setlistReadOf(stepCount, position, isLooping, look)
        : null,
    ),
  );
}

/** A scene look whose dip to white flashes. */
function flashingLook(): VjSceneLook {
  const look = vjSceneLookOf(createVjStageState(RESTORED_EPOCH, START));
  return { ...look, transition: { ...look.transition, mode: 'dipWhite' } };
}

interface Harness {
  gateway: VjGateway;
  stages: VjStageService;
  sockets: Map<string, FakeClient>;
  roomEmits: RoomEmit[];
  roleByUserId: Map<string, UserRole>;
  statusByUserId: Map<string, UserStatus>;
  /** The staff grants each user id holds. */
  grantsByUserId: Map<string, string[]>;
  staffRoles: { exists: jest.Mock };
  lockdown: {
    lockdownEnabled: boolean;
    lockdownAllowsModerators: boolean;
    lockdownMessage: string;
  };
  users: { findOne: jest.Mock };
  refreshTokens: { exists: jest.Mock };
  jwt: { verifyAsync: jest.Mock };
  reads: ReturnType<typeof createReads>;
  setlists: { updateSetlist: jest.Mock };
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
  const grantsByUserId = new Map<string, string[]>([
    [OPERATOR_USER_ID, ['vj_operator']],
    [MUSIC_PRODUCER_USER_ID, ['music_manager_producer']],
  ]);
  const staffRoles = {
    exists: jest.fn((options: { where: { userId: string; role: string }[] }) =>
      Promise.resolve(
        options.where.some((condition) =>
          (grantsByUserId.get(condition.userId) ?? []).includes(condition.role),
        ),
      ),
    ),
  };
  const lockdown = {
    lockdownEnabled: false,
    lockdownAllowsModerators: false,
    lockdownMessage: '',
  };
  const platformSettings = {
    get: jest.fn(() => Promise.resolve({ ...lockdown })),
  };
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
  const reads = createReads();
  const setlists = {
    updateSetlist: jest.fn(
      (_setlistId: string, body: { isLooping?: unknown }) =>
        Promise.resolve({ isLooping: body.isLooping }),
    ),
  };
  const stages = new VjStageService(reads as unknown as VjStageReadsService);
  const gateway = new VjGateway(
    jwt as unknown as JwtService,
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
    stages,
    reads as unknown as VjStageReadsService,
    users as unknown as Repository<User>,
    refreshTokens as unknown as Repository<RefreshToken>,
    staffRoles as unknown as Repository<UserStaffRole>,
    platformSettings as unknown as PlatformSettingsService,
    setlists as unknown as VjSetlistService,
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
    grantsByUserId,
    staffRoles,
    lockdown,
    users,
    refreshTokens,
    jwt,
    reads,
    setlists,
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

/** Every argument any Logger method received, one joined line per call. */
function spyOnEveryLogLine(): () => string[] {
  const spies = (['log', 'debug', 'warn', 'error', 'verbose'] as const).map(
    (method) => jest.spyOn(Logger.prototype, method),
  );
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map((call) => call.map(String).join(' ')),
    );
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
  restoreState: unknown = null,
) {
  const payload: VjAttachPayloadDto = {
    role: 'screen',
    contractVersion: VJ_CONTRACT_VERSION,
    screenId,
    restoreState,
  };
  return harness.gateway.handleAttach(asClient(client), payload);
}

function attachRemote(harness: Harness, client: FakeClient) {
  return harness.gateway.handleAttach(asClient(client), {
    role: 'remote',
    contractVersion: VJ_CONTRACT_VERSION,
  });
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

/** `stage:setEffects` toggling blackout: an immediate change, or a noop when
 *  blackout already holds that value. */
function setBlackout(
  harness: Harness,
  client: FakeClient,
  commandSequence: number,
  isBlackout: boolean,
) {
  return harness.gateway.handleSetEffects(asClient(client), {
    clientId: CLIENT_ID,
    commandSequence,
    isBlackout,
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

/** `stage:setTransition` with a fade of `value` ms. */
function setFadeLength(
  harness: Harness,
  client: FakeClient,
  commandSequence: number,
  value: number,
) {
  return harness.gateway.handleSetTransition(asClient(client), {
    clientId: CLIENT_ID,
    commandSequence,
    length: { unit: 'ms', value },
  });
}

function sendStatus(
  harness: Harness,
  client: FakeClient,
  isFullscreen: boolean,
  extraFields: Record<string, unknown> = {},
): Promise<void> {
  return harness.gateway.handleScreenStatus(asClient(client), {
    isFullscreen,
    preload: { packId: null, clips: [] },
    ...extraFields,
  });
}

/** A v2 restore naming PACK_ID and CLIP_ID from a stage the server lost. */
function buildRestoreState(
  parts: Partial<VjStageRestore> = {},
): VjStageRestore {
  const base = createVjStageState(RESTORED_EPOCH, START - 60_000);
  return {
    stageEpoch: base.stageEpoch,
    revision: 7,
    activePackId: PACK_ID,
    liveClipId: CLIP_ID,
    liveGeneratorId: null,
    liveGeneratorVariant: null,
    transition: base.transition,
    overlay: base.overlay,
    countdown: base.countdown,
    logo: base.logo,
    eventCard: base.eventCard,
    effects: base.effects,
    mix: base.mix,
    tempo: base.tempo,
    shuffle: base.shuffle,
    activeSetlistId: null,
    setlistIndex: null,
    setlistPlayback: base.setlistPlayback,
    ...parts,
  };
}

/** A library change with every id empty but the given ones. */
function libraryChange(
  parts: Partial<VjLibraryChange> & Pick<VjLibraryChange, 'kind'>,
): VjLibraryChange {
  return {
    packId: null,
    clipId: null,
    packIds: [],
    sceneId: null,
    setlistId: null,
    setlistIds: [],
    eventId: null,
    ...parts,
  };
}

function stageFrames(harness: Harness): RoomEmit[] {
  return roomEmitsOf(harness, 'stage:state').filter(
    (record) => record.room === vjStageRoomName(ADMIN_USER_ID),
  );
}

function payloadOf(record: RoomEmit | undefined): VjStageFrame {
  if (record === undefined) {
    throw new Error('expected a stage:state frame');
  }
  return record.payload as VjStageFrame;
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

      expect(ack).toEqual({
        ok: false,
        code: 'FORBIDDEN',
        serverNow: Date.now(),
      });
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

      expect(ack).toEqual({
        ok: true,
        exp: expect.any(Number) as number,
        serverNow: Date.now(),
      });
      if (!ack.ok) return;
      expect(ack.exp).toBeGreaterThan(handshakeExp);
      expect(client.data.exp).toBe(ack.exp);
      jest.advanceTimersByTime(120_000);
      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('the vj_operator grant', () => {
    it('admits a member holding the grant and attaches them to a stage of their own', async () => {
      const client = await connect(
        harness,
        'socket-operator',
        OPERATOR_USER_ID,
      );

      expect(clientEmits(client, 'exception')).toEqual([]);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.userId).toBe(OPERATOR_USER_ID);
      expect(harness.staffRoles.exists).toHaveBeenCalledWith({
        where: [{ userId: OPERATOR_USER_ID, role: 'vj_operator' }],
      });

      const ack = await attachRemote(harness, client);
      expect(ack.ok).toBe(true);
      expect(joinedRooms(client)).toEqual(
        expect.arrayContaining([
          vjStageRoomName(OPERATOR_USER_ID),
          vjRemotesRoomName(OPERATOR_USER_ID),
          VJ_LIBRARY_ROOM,
        ]),
      );
      expect(harness.stages.getState(OPERATOR_USER_ID)).not.toBeNull();
      expect(harness.stages.getState(ADMIN_USER_ID)).toBeNull();
    });

    it('refuses a member holding an unrelated grant with FORBIDDEN vj_not_admin', async () => {
      const client = await connect(
        harness,
        'socket-music',
        MUSIC_PRODUCER_USER_ID,
      );

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

    it('names the missing VJ access in the refusal message', () => {
      expect(VJ_NOT_ADMIN_MESSAGE).toContain('VJ operator grant');
      expect(VJ_NOT_ADMIN_MESSAGE).toContain('Admin role');
    });

    it('acks vj_not_admin past the cache once the grant is revoked, then drops the socket', async () => {
      const client = await connect(
        harness,
        'socket-operator',
        OPERATOR_USER_ID,
      );
      expect((await attachRemote(harness, client)).ok).toBe(true);

      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS + 1);
      expect((await setBlackout(harness, client, 1, true)).ok).toBe(true);

      harness.grantsByUserId.delete(OPERATOR_USER_ID);
      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS + 1);
      const ack = await setBlackout(harness, client, 2, false);

      expect(ack).toEqual({
        ok: false,
        code: 'vj_not_admin',
        message: VJ_NOT_ADMIN_MESSAGE,
        serverNow: Date.now(),
      });
      await flushImmediate();
      expect(clientEmits(client, 'exception')).toEqual([
        expect.objectContaining({
          code: 'FORBIDDEN',
          domainCode: 'vj_not_admin',
        }),
      ]);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('refuses a reauth once the grant is revoked', async () => {
      const client = await connect(
        harness,
        'socket-operator',
        OPERATOR_USER_ID,
      );
      harness.grantsByUserId.delete(OPERATOR_USER_ID);
      const { ticket } = socketTicketService.mint(
        OPERATOR_USER_ID,
        `family-${OPERATOR_USER_ID}`,
        UserStatus.Active,
        15 * 60_000,
      );

      const ack = await harness.gateway.handleReauth(asClient(client), {
        ticket,
      });

      expect(ack).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      await flushImmediate();
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('refuses a grant holder during a lockdown and admits an admin', async () => {
      harness.lockdown.lockdownEnabled = true;
      harness.lockdown.lockdownMessage = 'Back after the maintenance window';

      const operator = await connect(
        harness,
        'socket-operator',
        OPERATOR_USER_ID,
      );
      expect(clientEmits(operator, 'exception')).toEqual([
        expect.objectContaining({
          code: 'PLATFORM_LOCKED',
          message: 'Back after the maintenance window',
        }),
      ]);
      expect(operator.disconnect).toHaveBeenCalledWith(true);

      const admin = await connect(harness, 'socket-admin');
      expect(admin.disconnect).not.toHaveBeenCalled();
      expect(admin.data.userId).toBe(ADMIN_USER_ID);
    });

    it('drops only the grant sockets when a lockdown is switched on', async () => {
      const operator = await connect(
        harness,
        'socket-operator',
        OPERATOR_USER_ID,
      );
      const admin = await connect(harness, 'socket-admin');
      harness.lockdown.lockdownEnabled = true;

      await harness.gateway.handleLockdownEnabled();

      expect(clientEmits(operator, 'exception')).toEqual([
        expect.objectContaining({ code: 'PLATFORM_LOCKED' }),
      ]);
      expect(operator.disconnect).toHaveBeenCalledWith(true);
      expect(clientEmits(admin, 'exception')).toEqual([]);
      expect(admin.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('per-frame admin recheck', () => {
    it('rechecks the role at most once per five seconds per socket', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      // The handshake read covers the attach.
      expect(harness.users.findOne).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS + 1);
      expect((await setBlackout(harness, remote, 1, true)).ok).toBe(true);
      expect(harness.users.findOne).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(2000);
      expect((await setBlackout(harness, remote, 2, false)).ok).toBe(true);
      jest.advanceTimersByTime(2999);
      expect((await setBlackout(harness, remote, 3, true)).ok).toBe(true);
      expect(harness.users.findOne).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(2);
      expect((await setBlackout(harness, remote, 4, false)).ok).toBe(true);
      expect(harness.users.findOne).toHaveBeenCalledTimes(3);
    });

    it('acks vj_not_admin to a demoted admin and drops the socket after the ack', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      harness.roleByUserId.set(ADMIN_USER_ID, UserRole.Moderator);
      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS);

      const ack = await setBlackout(harness, remote, 1, true);

      expect(ack).toEqual({
        ok: false,
        code: 'vj_not_admin',
        message: VJ_NOT_ADMIN_MESSAGE,
        serverNow: Date.now(),
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

      const commandPending = setBlackout(harness, remote, 1, true);
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
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' });

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

      const ack = await setBlackout(harness, remote, 1, true);

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
        screenNumber: 1,
        serverNow: START,
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
          applyAt: null,
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

    it('answers the second screen its number', async () => {
      await attachedScreen(harness, 'socket-first');
      const second = await connect(harness, 'socket-second');

      const ack = await attachScreen(harness, second, OTHER_SCREEN_ID);

      expect(ack).toMatchObject({ ok: true, isLead: false, screenNumber: 2 });
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
        screenNumber: null,
        serverNow: START,
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
        expect.objectContaining({
          cause: 'attach',
          sourceClientId: null,
          applyAt: null,
        }),
      ]);
      expect(clientEmits(remote, 'screens:update')).toEqual([{ screens: [] }]);
    });

    it('answers vj_already_attached for a second attach', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');

      const second = await attachScreen(harness, remote);

      expect(codeOf(second)).toBe('vj_already_attached');
      expect(remote.data.role).toBe('remote');
    });

    it('answers vj_client_outdated to an attach without contractVersion 2 and releases the claim', async () => {
      const screen = await connect(harness, 'socket-screen');

      const missing = await harness.gateway.handleAttach(asClient(screen), {
        role: 'screen',
        screenId: SCREEN_ID,
        restoreState: null,
      });
      const older = await harness.gateway.handleAttach(asClient(screen), {
        role: 'remote',
        contractVersion: 1,
      });

      expect(codeOf(missing)).toBe('vj_client_outdated');
      expect(codeOf(older)).toBe('vj_client_outdated');
      expect(screen.data.role).toBeUndefined();
      expect(screen.data.isAttached).toBeUndefined();
      expect(harness.stages.getState(ADMIN_USER_ID)).toBeNull();
      expect(await attachScreen(harness, screen)).toMatchObject({
        ok: true,
        role: 'screen',
      });
    });

    it('answers vj_not_attached for a command before attach', async () => {
      const client = await connect(harness, 'socket-fresh');

      expect(codeOf(await setBlackout(harness, client, 1, true))).toBe(
        'vj_not_attached',
      );
    });

    it('answers vj_wrong_role for a remote frame on a screen and a screen frame on a remote', async () => {
      const screen = await attachedScreen(harness, 'socket-screen');
      const remote = await attachedRemote(harness, 'socket-remote');

      expect(codeOf(await setBlackout(harness, screen, 1, true))).toBe(
        'vj_wrong_role',
      );
      const advance = await harness.gateway.handleScreenAdvance(
        asClient(remote),
        { expectedClipSequence: 0, clipId: CLIP_ID },
      );
      expect(codeOf(advance)).toBe('vj_wrong_role');
    });

    it('broadcasts a restore to the whole stage with applyAt null', async () => {
      const screen = await connect(harness, 'socket-screen');

      const ack = await attachScreen(
        harness,
        screen,
        SCREEN_ID,
        buildRestoreState(),
      );

      expect(ack).toMatchObject({ ok: true, isRestored: true, isLead: true });
      expect(harness.reads.readPackForStage).toHaveBeenCalledTimes(1);
      expect(harness.reads.readPackForStage).toHaveBeenCalledWith(PACK_ID);
      expect(harness.reads.existingClipIds).toHaveBeenCalledTimes(1);
      expect(harness.reads.existingClipIds).toHaveBeenCalledWith([CLIP_ID]);

      await flushImmediate();
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = payloadOf(frames[0]);
      expect(frame.cause).toBe('restore');
      expect(frame.sourceClientId).toBeNull();
      expect(frame.applyAt).toBeNull();
      expect(frame.state.activePackId).toBe(PACK_ID);
      expect(frame.state.liveClipId).toBe(CLIP_ID);
      expect(frame.state.revision).toBe(1);
      // The restore went to the room, so the screen got no private copy.
      expect(clientEmits(screen, 'stage:state')).toEqual([]);
    });

    it('seeds a v2 stage from a v1-shaped restore', async () => {
      const base = createVjStageState(RESTORED_EPOCH, START - 60_000);
      const restoreState = {
        stageEpoch: base.stageEpoch,
        revision: 7,
        activePackId: PACK_ID,
        liveClipId: CLIP_ID,
        transition: { mode: 'cut', fadeMs: 300 },
        overlay: { text: 'Hello', style: 'big', isVisible: false },
        effects: {
          speed: 2,
          isMonochrome: true,
          isMirrored: false,
          isHueCycling: false,
          isStrobing: true,
          isBlackout: false,
          strobeStartedAt: 5,
        },
        shuffle: {
          isOn: true,
          intervalKind: 'beats',
          intervalValue: 16,
          bpm: 128,
        },
      };
      const screen = await connect(harness, 'socket-screen');

      const ack = await attachScreen(harness, screen, SCREEN_ID, restoreState);

      expect(ack).toMatchObject({ ok: true, isRestored: true });
      expect(harness.reads.readPackForStage).toHaveBeenCalledWith(PACK_ID);
      expect(harness.reads.existingClipIds).toHaveBeenCalledWith([CLIP_ID]);
      await flushImmediate();
      const frame = payloadOf(stageFrames(harness)[0]);
      expect(frame.cause).toBe('restore');
      expect(frame.applyAt).toBeNull();
      expect(frame.state).toMatchObject({
        revision: 1,
        activePackId: PACK_ID,
        liveClipId: CLIP_ID,
        transition: { mode: 'cut', length: { unit: 'ms', value: 300 } },
        tempo: { bpm: 128 },
      });
      expect(frame.state.effects.settings.monochrome?.isOn).toBe(true);
      expect(frame.state.effects.isStrobing).toBe(false);
    });

    it('resolves each lookup once and in parallel', async () => {
      let resolvePackRead: (pack: { eventId: string | null }) => void = () =>
        undefined;
      harness.reads.readPackForStage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePackRead = resolve;
          }),
      );
      const base = createVjStageState(RESTORED_EPOCH, START - 60_000);
      const restoreState = buildRestoreState({
        mix: { ...base.mix, clipId: MIX_CLIP_ID, amount: 0.5 },
        shuffle: { ...base.shuffle, excludedClipIds: [EXCLUDED_CLIP_ID] },
        activeSetlistId: SETLIST_ID,
      });
      const screen = await connect(harness, 'socket-screen');

      const attachPending = attachScreen(
        harness,
        screen,
        SCREEN_ID,
        restoreState,
      );
      await flushImmediate();

      // Every other read started while the pack read still waits.
      expect(harness.reads.readPackForStage).toHaveBeenCalledTimes(1);
      expect(harness.reads.existingClipIds).toHaveBeenCalledTimes(1);
      expect(
        [...(harness.reads.existingClipIds.mock.calls[0]?.[0] ?? [])].sort(),
      ).toEqual([CLIP_ID, MIX_CLIP_ID]);
      expect(harness.reads.clipIdsInPack).toHaveBeenCalledTimes(1);
      expect(harness.reads.clipIdsInPack).toHaveBeenCalledWith(PACK_ID, [
        EXCLUDED_CLIP_ID,
      ]);
      expect(harness.reads.readSetlist).toHaveBeenCalledTimes(1);
      expect(harness.reads.readSetlist).toHaveBeenCalledWith(SETLIST_ID, {
        kind: 'count',
      });

      resolvePackRead({ eventId: null });
      expect(await attachPending).toMatchObject({
        ok: true,
        isRestored: true,
      });
      expect(harness.reads.readPackForStage).toHaveBeenCalledTimes(1);
      expect(harness.reads.existingClipIds).toHaveBeenCalledTimes(1);
    });

    it('acks vj_server_error when a restore read fails and attaches nothing', async () => {
      harness.reads.existingClipIds.mockRejectedValueOnce(
        new Error('read failed near SECRET-DB-DETAIL'),
      );
      const screen = await connect(harness, 'socket-screen');

      const ack = await attachScreen(
        harness,
        screen,
        SCREEN_ID,
        buildRestoreState(),
      );

      expect(codeOf(ack)).toBe('vj_server_error');
      expect(screen.data.role).toBeUndefined();
      expect(screen.data.isAttached).toBeUndefined();
    });

    it('answers vj_not_attached for a frame sent while a screen attach awaits its restore reads', async () => {
      let resolvePackRead: (pack: { eventId: string | null }) => void = () =>
        undefined;
      harness.reads.readPackForStage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
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
      expect(harness.reads.readPackForStage).toHaveBeenCalledTimes(1);

      const advance = await harness.gateway.handleScreenAdvance(
        asClient(screen),
        { expectedClipSequence: 0, clipId: CLIP_ID },
      );
      const command = await setBlackout(harness, screen, 1, true);

      expect(codeOf(advance)).toBe('vj_not_attached');
      expect(codeOf(command)).toBe('vj_not_attached');
      expect(harness.reads.readPackClipForAdvance).not.toHaveBeenCalled();

      resolvePackRead({ eventId: null });
      expect(await attachPending).toMatchObject({
        ok: true,
        isRestored: true,
      });
      expect(screen.data.isAttached).toBe(true);
    });

    it('carries applyAt on the attach frame while a change is pending', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      const tempo = await harness.gateway.handleSetTempo(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        bpm: 120,
        downbeatAt: START,
        quantize: 'beat',
      });
      expect(tempo).toMatchObject({ ok: true, applyAt: null });
      jest.setSystemTime(START + 100);

      const tap = await harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 2,
        clipId: CLIP_ID,
      });
      expect(tap).toEqual({
        ok: true,
        revision: 2,
        isNoop: false,
        applyAt: START + 500,
        serverNow: START + 100,
      });

      const lateRemote = await attachedRemote(harness, 'socket-late-remote');
      const lateScreen = await attachedScreen(harness, 'socket-late-screen');
      await flushImmediate();
      expect(clientEmits(lateRemote, 'stage:state')).toEqual([
        expect.objectContaining({ cause: 'attach', applyAt: START + 500 }),
      ]);
      expect(clientEmits(lateScreen, 'stage:state')).toEqual([
        expect.objectContaining({ cause: 'attach', applyAt: START + 500 }),
      ]);

      jest.setSystemTime(START + 600);
      const afterLanding = await attachedRemote(harness, 'socket-after');
      await flushImmediate();
      expect(clientEmits(afterLanding, 'stage:state')).toEqual([
        expect.objectContaining({ cause: 'attach', applyAt: null }),
      ]);
    });

    it('reads the attach frame applyAt with the state it sends on the next tick', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      const tempo = await harness.gateway.handleSetTempo(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        bpm: 120,
        downbeatAt: START,
        quantize: 'beat',
      });
      expect(tempo).toMatchObject({ ok: true, applyAt: null });
      await flushImmediate();
      jest.setSystemTime(START + 100);

      const lateRemote = await attachedRemote(harness, 'socket-late-remote');
      const lateScreen = await attachedScreen(harness, 'socket-late-screen');
      const tap = await harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 2,
        clipId: CLIP_ID,
      });
      expect(tap).toMatchObject({ ok: true, applyAt: START + 500 });
      await flushImmediate();

      for (const client of [lateRemote, lateScreen]) {
        expect(clientEmits(client, 'stage:state')).toEqual([
          expect.objectContaining({
            cause: 'attach',
            applyAt: START + 500,
            state: expect.objectContaining({
              revision: 2,
              liveClipId: CLIP_ID,
            }) as unknown,
          }),
        ]);
      }
    });

    it('answers vj_screen_id_invalid before any restore read', async () => {
      const screen = await connect(harness, 'socket-screen');

      const ack = await attachScreen(
        harness,
        screen,
        'not-a-screen-id',
        buildRestoreState(),
      );

      expect(codeOf(ack)).toBe('vj_screen_id_invalid');
      expect(harness.reads.readPackForStage).not.toHaveBeenCalled();
      expect(harness.reads.existingClipIds).not.toHaveBeenCalled();
      expect(screen.data.role).toBeUndefined();
      expect(screen.data.isAttached).toBeUndefined();
      expect(harness.stages.getState(ADMIN_USER_ID)).toBeNull();
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

      const ack = await setBlackout(harness, remote, 1, true);

      expect(ack).toEqual({
        ok: true,
        revision: 1,
        isNoop: false,
        applyAt: null,
        serverNow: START,
      });
      expect(stageFrames(harness)).toEqual([]);
      await flushImmediate();
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = payloadOf(frames[0]);
      expect(frame.cause).toBe('command');
      expect(frame.sourceClientId).toBe(CLIENT_ID);
      expect(frame.applyAt).toBeNull();
      expect(frame.state.effects.isBlackout).toBe(true);
      expect(frame.state.revision).toBe(1);
    });

    it('applies a goClip awaiting its clip read before a later setTransition', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      let resolveClipRead: (clipIds: Set<string>) => void = () => undefined;
      harness.reads.existingClipIds.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveClipRead = resolve;
          }),
      );

      const goClipPending = harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 5,
        clipId: CLIP_ID,
      });
      const transitionPending = setFadeLength(harness, remote, 6, 1200);
      await flushImmediate();

      // The later command waits behind the earlier one's read.
      expect(harness.reads.existingClipIds).toHaveBeenCalledTimes(1);
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);

      resolveClipRead(new Set([CLIP_ID]));
      const goClipAck = await goClipPending;
      const transitionAck = await transitionPending;

      expect(goClipAck).toMatchObject({ ok: true, revision: 1, isNoop: false });
      expect(transitionAck).toMatchObject({
        ok: true,
        revision: 2,
        isNoop: false,
      });
      const state = harness.stages.getState(ADMIN_USER_ID);
      expect(state?.liveClipId).toBe(CLIP_ID);
      expect(state?.transition.length).toEqual({ unit: 'ms', value: 1200 });
    });

    it('refuses a frame past the bucket on arrival while earlier commands wait in the queue', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      let resolveClipRead: (clipIds: Set<string>) => void = () => undefined;
      harness.reads.existingClipIds.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
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
          setFadeLength(harness, remote, sequence, sequence * 10),
        );
      }

      // The goClip clip read is in flight and holds the queue.
      await flushImmediate();
      expect(harness.reads.existingClipIds).toHaveBeenCalledTimes(1);

      // The 41st frame answers while the goClip read still holds the queue.
      const refused = await setFadeLength(harness, remote, 41, 2000);
      expect(codeOf(refused)).toBe('vj_rate_limited');
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);

      resolveClipRead(new Set([CLIP_ID]));
      expect(await goClipPending).toMatchObject({
        ok: true,
        revision: 1,
        isNoop: false,
      });
      const transitionAcks = await Promise.all(queuedTransitions);
      expect(transitionAcks.every((ack) => ack.ok)).toBe(true);
      const state = harness.stages.getState(ADMIN_USER_ID);
      expect(state?.revision).toBe(40);
      expect(state?.liveClipId).toBe(CLIP_ID);
      expect(state?.transition.length).toEqual({ unit: 'ms', value: 400 });
    });

    it('meters setMix and setEffects on their own buckets', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      const mixCodes: (string | null)[] = [];
      for (let sequence = 1; sequence <= 61; sequence += 1) {
        const ack = await harness.gateway.handleSetMix(asClient(remote), {
          clientId: CLIENT_ID,
          commandSequence: sequence,
          amount: (sequence % 10) / 10,
        });
        mixCodes.push(codeOf(ack));
      }
      expect(
        mixCodes.filter((code) => code === 'vj_rate_limited'),
      ).toHaveLength(1);
      expect(mixCodes[60]).toBe('vj_rate_limited');

      const effectsCodes: (string | null)[] = [];
      for (let sequence = 62; sequence <= 122; sequence += 1) {
        const ack = await harness.gateway.handleSetEffects(asClient(remote), {
          clientId: CLIENT_ID,
          commandSequence: sequence,
          speed: sequence % 2 === 0 ? 2 : 1,
        });
        effectsCodes.push(codeOf(ack));
      }
      expect(effectsCodes.slice(0, 60)).toEqual(
        Array.from({ length: 60 }, () => null),
      );
      expect(effectsCodes[60]).toBe('vj_rate_limited');

      // The command bucket is untouched by both.
      const tap = await harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 123,
        clipId: CLIP_ID,
      });
      expect(tap).toMatchObject({ ok: true, isNoop: false });
    });

    it('runs the next command after a command that failed', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      jest
        .spyOn(harness.stages, 'runRemoteCommand')
        .mockImplementationOnce(() => {
          throw new Error('stage broke');
        });

      const failed = setBlackout(harness, remote, 1, true);
      const next = setBlackout(harness, remote, 2, true);

      expect(codeOf(await failed)).toBe('vj_server_error');
      expect(await next).toMatchObject({
        ok: true,
        revision: 1,
        isNoop: false,
      });
    });

    it('broadcasts nothing for a noop', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();

      const ack = await setBlackout(harness, remote, 1, false);

      expect(ack).toEqual({
        ok: true,
        revision: 0,
        isNoop: true,
        applyAt: null,
        serverNow: START,
      });
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

    it('acks vj_server_error when the stage rejects and logs the code only', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug');
      const remote = await attachedRemote(harness, 'socket-remote');
      jest
        .spyOn(harness.stages, 'runRemoteCommand')
        .mockRejectedValue(new Error('stage broke near SECRET-STAGE-DETAIL'));

      const ack = await setBlackout(harness, remote, 1, true);

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

    it('acks vj_server_error when a lookup read fails', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      harness.reads.existingClipIds.mockRejectedValueOnce(
        new Error('read failed'),
      );

      const ack = await harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        clipId: CLIP_ID,
      });

      expect(codeOf(ack)).toBe('vj_server_error');
      expect(harness.stages.getState(ADMIN_USER_ID)?.liveClipId).toBeNull();
      await flushImmediate();
      expect(stageFrames(harness)).toEqual([]);
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

      expect((await setBlackout(harness, secondRemote, 1, true)).ok).toBe(true);
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
      expect(harness.reads.readPackForStage).toHaveBeenCalledTimes(1);
      expect(harness.reads.readPackForStage).toHaveBeenCalledWith(PACK_ID);

      const stale = await setPack(harness, remote, 1, PACK_ID);

      expect(codeOf(stale)).toBe('vj_stale_command');
      expect(stale.ok ? undefined : stale.state?.activePackId).toBe(PACK_ID);
      expect(harness.reads.readPackForStage).toHaveBeenCalledTimes(1);
    });

    it('answers vj_pack_not_found when the pack read finds nothing', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      harness.reads.readPackForStage.mockResolvedValueOnce(null);

      expect(codeOf(await setPack(harness, remote, 1, PACK_ID))).toBe(
        'vj_pack_not_found',
      );
      expect(harness.stages.getState(ADMIN_USER_ID)?.activePackId).toBeNull();
    });

    it('refuses the 41st command in a burst with vj_rate_limited', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');

      for (let sequence = 1; sequence <= 40; sequence += 1) {
        const ack = await setFadeLength(harness, remote, sequence, sequence);
        expect(ack.ok).toBe(true);
      }

      expect(codeOf(await setFadeLength(harness, remote, 41, 41))).toBe(
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
      expect(harness.reads.readPackClipForAdvance).not.toHaveBeenCalled();
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

    it('broadcasts a mic tempo adoption from the lead status', async () => {
      const lead = await attachedScreen(harness, 'socket-lead');
      const remote = await attachedRemote(harness, 'socket-remote');
      await sendStatus(harness, lead, true, {
        mic: { level: 0.4, bpm: null, confidence: 0, beatAt: null },
      });
      const toMic = await harness.gateway.handleSetTempo(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        source: 'mic',
      });
      expect(toMic.ok).toBe(true);
      await flushImmediate();
      harness.roomEmits.length = 0;
      jest.setSystemTime(START + 100);

      await sendStatus(harness, lead, true, {
        mic: { level: 0.5, bpm: 130, confidence: 0.9, beatAt: START + 100 },
      });

      expect(stageFrames(harness)).toEqual([]);
      await flushImmediate();
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = payloadOf(frames[0]);
      expect(frame.cause).toBe('mic_tempo');
      expect(frame.sourceClientId).toBeNull();
      expect(frame.state.tempo).toMatchObject({ bpm: 130, source: 'mic' });
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
      const change = libraryChange({
        kind: 'pack_deleted',
        packId: PACK_ID,
        packIds: [PACK_ID],
      });

      await harness.gateway.handleLibraryChanged(change);

      expect(roomEmitsOf(harness, 'library:changed')).toEqual([
        { room: VJ_LIBRARY_ROOM, event: 'library:changed', payload: change },
      ]);
      expect(stageFrames(harness)).toEqual([]);
      await flushImmediate();
      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = payloadOf(frames[0]);
      expect(frame.cause).toBe('library');
      expect(frame.sourceClientId).toBeNull();
      expect(frame.state.activePackId).toBeNull();
      expect(harness.reads.readSetlistFollow).not.toHaveBeenCalled();
    });

    it('keeps a library frame behind a command frame still waiting for its tick', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();
      harness.roomEmits.length = 0;

      expect((await setPack(harness, remote, 1, PACK_ID)).ok).toBe(true);
      expect(stageFrames(harness)).toEqual([]);
      await harness.gateway.handleLibraryChanged(
        libraryChange({
          kind: 'pack_deleted',
          packId: PACK_ID,
          packIds: [PACK_ID],
        }),
      );
      await flushImmediate();

      const frames = stageFrames(harness).map(payloadOf);
      expect(
        frames.map((frame) => [frame.cause, frame.state.revision]),
      ).toEqual([
        ['command', 1],
        ['library', 2],
      ]);
    });

    describe('sequence playback and Loop', () => {
      /** An attached remote with SETLIST_ID (three steps) shown at step 1. */
      async function remoteOnSequence(isPlaying = false): Promise<FakeClient> {
        const remote = await attachedRemote(harness, 'socket-remote');
        serveSetlistReads(harness.reads, 3);
        const select = await harness.gateway.handleSetlistSelect(
          asClient(remote),
          {
            clientId: CLIENT_ID,
            commandSequence: 1,
            setlistId: SETLIST_ID,
            index: 0,
            isPlaying,
          },
        );
        expect(select.ok).toBe(true);
        await flushImmediate();
        harness.roomEmits.length = 0;
        return remote;
      }

      it('pauses and resumes a playing sequence through stage:setlistSetPlaying', async () => {
        const remote = await remoteOnSequence(true);
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.status,
        ).toBe('playing');

        const paused = await harness.gateway.handleSetlistSetPlaying(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 2, isPlaying: false },
        );
        expect(paused).toMatchObject({ ok: true, isNoop: false });
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback,
        ).toMatchObject({ status: 'paused', stepEndsAt: null });

        const resumed = await harness.gateway.handleSetlistSetPlaying(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 3, isPlaying: true },
        );
        expect(resumed).toMatchObject({ ok: true, isNoop: false });
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.status,
        ).toBe('playing');
        await flushImmediate();
        expect(
          stageFrames(harness).map((record) => payloadOf(record).cause),
        ).toEqual(['command', 'command']);
      });

      it('answers vj_setlist_flash_unconfirmed without a log line', async () => {
        const readLogLines = spyOnEveryLogLine();
        const remote = await attachedRemote(harness, 'socket-remote');
        serveSetlistReads(harness.reads, 3, false, flashingLook());

        const ack = await harness.gateway.handleSetlistSelect(
          asClient(remote),
          {
            clientId: CLIENT_ID,
            commandSequence: 1,
            setlistId: SETLIST_ID,
            index: 0,
            isPlaying: true,
          },
        );

        expect(codeOf(ack)).toBe('vj_setlist_flash_unconfirmed');
        expect(
          readLogLines().some((line) =>
            line.includes('vj_setlist_flash_unconfirmed'),
          ),
        ).toBe(false);
      });

      it('saves Loop on the active set list before the playback change lands', async () => {
        const remote = await remoteOnSequence();
        const loopingAtWrite: (boolean | undefined)[] = [];
        harness.setlists.updateSetlist.mockImplementationOnce(() => {
          loopingAtWrite.push(
            harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.isLooping,
          );
          return Promise.resolve({ isLooping: true });
        });

        const ack = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 2, isLooping: true },
        );

        expect(ack).toMatchObject({ ok: true, isNoop: false });
        expect(harness.setlists.updateSetlist).toHaveBeenCalledTimes(1);
        expect(harness.setlists.updateSetlist).toHaveBeenCalledWith(
          SETLIST_ID,
          { isLooping: true },
        );
        expect(loopingAtWrite).toEqual([false]);
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.isLooping,
        ).toBe(true);
        await flushImmediate();
        const frame = payloadOf(stageFrames(harness)[0]);
        expect(frame.cause).toBe('command');
        expect(frame.sourceClientId).toBe(CLIENT_ID);
      });

      it('lands the Loop the save answered when it differs from the payload', async () => {
        const remote = await remoteOnSequence();
        harness.setlists.updateSetlist.mockResolvedValueOnce({
          isLooping: false,
        });

        const ack = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 2, isLooping: true },
        );

        expect(harness.setlists.updateSetlist).toHaveBeenCalledWith(
          SETLIST_ID,
          { isLooping: true },
        );
        expect(ack).toMatchObject({ ok: true, isNoop: true });
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.isLooping,
        ).toBe(false);
        await flushImmediate();
        expect(stageFrames(harness)).toEqual([]);
      });

      it('answers vj_setlist_not_found when the Loop save no longer finds the set list and records the sequence', async () => {
        const remote = await remoteOnSequence();
        harness.setlists.updateSetlist.mockRejectedValueOnce(
          vjError('VJ_SETLIST_NOT_FOUND'),
        );
        const payload = {
          clientId: CLIENT_ID,
          commandSequence: 2,
          isLooping: true,
        };

        const ack = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          payload,
        );

        expect(codeOf(ack)).toBe('vj_setlist_not_found');
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.isLooping,
        ).toBe(false);
        const again = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          payload,
        );
        expect(codeOf(again)).toBe('vj_stale_command');
        expect(harness.setlists.updateSetlist).toHaveBeenCalledTimes(1);
        await flushImmediate();
        expect(stageFrames(harness)).toEqual([]);
      });

      it('answers vj_stale_setlist and lands nothing when another remote stopped the sequence during the Loop save', async () => {
        const otherClientId = 'abababab-abab-4bab-8bab-abababababab';
        const remote = await remoteOnSequence();
        const otherRemote = await attachedRemote(harness, 'socket-other');
        await flushImmediate();
        harness.roomEmits.length = 0;
        harness.setlists.updateSetlist.mockImplementationOnce(async () => {
          const stop = await harness.gateway.handleSetlistSelect(
            asClient(otherRemote),
            {
              clientId: otherClientId,
              commandSequence: 1,
              setlistId: null,
              index: null,
            },
          );
          expect(stop.ok).toBe(true);
          return {};
        });
        const payload = {
          clientId: CLIENT_ID,
          commandSequence: 2,
          isLooping: true,
        };

        const ack = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          payload,
        );

        expect(codeOf(ack)).toBe('vj_stale_setlist');
        if (ack.ok) {
          throw new Error('expected a refusal');
        }
        expect(ack.state?.activeSetlistId).toBeNull();
        expect(harness.stages.getState(ADMIN_USER_ID)?.activeSetlistId).toBe(
          null,
        );
        await flushImmediate();
        expect(
          stageFrames(harness).map(
            (record) => payloadOf(record).sourceClientId,
          ),
        ).toEqual([otherClientId]);
        const again = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          payload,
        );
        expect(codeOf(again)).toBe('vj_stale_command');
        expect(harness.setlists.updateSetlist).toHaveBeenCalledTimes(1);
      });

      it('never saves Loop for a frame past the command bucket', async () => {
        const remote = await remoteOnSequence();
        // The select took one token; transitions take the rest.
        for (
          let sequence = 2;
          sequence <= VJ_COMMAND_RATE_LIMIT.capacity;
          sequence += 1
        ) {
          expect(
            (await setFadeLength(harness, remote, sequence, sequence * 10)).ok,
          ).toBe(true);
        }

        const flood = await Promise.all(
          Array.from({ length: 5 }, (_unused, offset) =>
            harness.gateway.handleSetlistSetLooping(asClient(remote), {
              clientId: CLIENT_ID,
              commandSequence: VJ_COMMAND_RATE_LIMIT.capacity + 1 + offset,
              isLooping: true,
            }),
          ),
        );

        expect(flood.map(codeOf)).toEqual(
          Array.from({ length: 5 }, () => 'vj_rate_limited'),
        );
        expect(harness.setlists.updateSetlist).not.toHaveBeenCalled();
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.isLooping,
        ).toBe(false);
      });

      it('answers vj_server_error for any other failed Loop save', async () => {
        const remote = await remoteOnSequence();
        harness.setlists.updateSetlist.mockRejectedValueOnce(
          new Error('write failed near SECRET-DB-DETAIL'),
        );

        const ack = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 2, isLooping: true },
        );

        expect(codeOf(ack)).toBe('vj_server_error');
        expect(
          harness.stages.getState(ADMIN_USER_ID)?.setlistPlayback.isLooping,
        ).toBe(false);
      });

      it('writes nothing when the Loop frame fails its rules', async () => {
        const remote = await attachedRemote(harness, 'socket-remote');
        const withoutSetlist = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 1, isLooping: true },
        );
        expect(codeOf(withoutSetlist)).toBe('vj_setlist_none');

        serveSetlistReads(harness.reads, 3);
        await harness.gateway.handleSetlistSelect(asClient(remote), {
          clientId: CLIENT_ID,
          commandSequence: 2,
          setlistId: SETLIST_ID,
          index: null,
        });
        const wrongFlag = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 3, isLooping: 'yes' },
        );
        expect(codeOf(wrongFlag)).toBe('vj_effect_flag_invalid');
        expect(harness.setlists.updateSetlist).not.toHaveBeenCalled();
        const next = await harness.gateway.handleSetlistSetLooping(
          asClient(remote),
          { clientId: CLIENT_ID, commandSequence: 3, isLooping: true },
        );
        expect(codeOf(next)).toBe('vj_stale_command');
      });
    });

    it('relays the eight library change fields and follows the active set list with its follow read', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      serveSetlistReads(harness.reads, 3);
      const select = await harness.gateway.handleSetlistSelect(
        asClient(remote),
        {
          clientId: CLIENT_ID,
          commandSequence: 1,
          setlistId: SETLIST_ID,
          index: 2,
        },
      );
      expect(select.ok).toBe(true);
      expect(harness.stages.getState(ADMIN_USER_ID)).toMatchObject({
        activeSetlistId: SETLIST_ID,
        setlistIndex: 2,
      });
      await flushImmediate();
      harness.roomEmits.length = 0;
      // The step on screen (index 2) is removed: the follow lands on the one
      // before it.
      harness.reads.readSetlistFollow.mockResolvedValueOnce({
        itemIds: setlistItemIdsOf(2),
        isLooping: false,
      });
      const change: VjLibraryChange = {
        kind: 'setlist_items_changed',
        packId: PACK_ID,
        clipId: CLIP_ID,
        packIds: [PACK_ID],
        sceneId: SCENE_ID,
        setlistId: SETLIST_ID,
        setlistIds: [SETLIST_ID, OTHER_SETLIST_ID],
        eventId: null,
      };

      await harness.gateway.handleLibraryChanged(change);

      const relayed = roomEmitsOf(harness, 'library:changed');
      expect(relayed).toEqual([
        { room: VJ_LIBRARY_ROOM, event: 'library:changed', payload: change },
      ]);
      const relayedPayload = relayed[0]?.payload as VjLibraryChange;
      expect(relayedPayload).not.toBe(change);
      expect(relayedPayload.setlistIds).not.toBe(change.setlistIds);
      expect(harness.reads.readSetlistFollow).toHaveBeenCalledTimes(1);
      expect(harness.reads.readSetlistFollow).toHaveBeenCalledWith(SETLIST_ID);
      await flushImmediate();
      const frame = payloadOf(stageFrames(harness)[0]);
      expect(frame.cause).toBe('library');
      expect(frame.state.activeSetlistId).toBe(SETLIST_ID);
      expect(frame.state.setlistIndex).toBe(1);
      expect(frame.state.setlistPlayback.itemId).toBeNull();
    });

    it.each(['clip_deleted', 'setlist_updated'] as const)(
      'reads the follow of the active set list on %s',
      async (kind) => {
        const remote = await attachedRemote(harness, 'socket-remote');
        serveSetlistReads(harness.reads, 3);
        await harness.gateway.handleSetlistSelect(asClient(remote), {
          clientId: CLIENT_ID,
          commandSequence: 1,
          setlistId: SETLIST_ID,
          index: 1,
        });
        await flushImmediate();
        harness.roomEmits.length = 0;
        harness.reads.readSetlistFollow.mockResolvedValueOnce({
          itemIds: setlistItemIdsOf(3),
          isLooping: true,
        });

        await harness.gateway.handleLibraryChanged(
          libraryChange({
            kind,
            clipId: kind === 'clip_deleted' ? CLIP_ID : null,
            setlistId: kind === 'setlist_updated' ? SETLIST_ID : null,
            setlistIds: [SETLIST_ID],
          }),
        );
        await flushImmediate();

        expect(harness.reads.readSetlistFollow).toHaveBeenCalledWith(
          SETLIST_ID,
        );
        const frame = payloadOf(stageFrames(harness)[0]);
        expect(frame.cause).toBe('library');
        expect(frame.state.setlistIndex).toBe(1);
        expect(frame.state.setlistPlayback.isLooping).toBe(true);
      },
    );

    it('clears the active set list when the follow read of a clip delete finds it gone', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      serveSetlistReads(harness.reads, 3);
      await harness.gateway.handleSetlistSelect(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        setlistId: SETLIST_ID,
        index: 1,
      });
      await flushImmediate();
      harness.roomEmits.length = 0;
      harness.reads.readSetlistFollow.mockResolvedValueOnce(null);

      await harness.gateway.handleLibraryChanged(
        libraryChange({
          kind: 'clip_deleted',
          clipId: CLIP_ID,
          setlistIds: [SETLIST_ID],
        }),
      );
      await flushImmediate();

      const frame = payloadOf(stageFrames(harness)[0]);
      expect(frame.state.activeSetlistId).toBeNull();
      expect(frame.state.setlistIndex).toBeNull();
    });

    it('applies a set list change with the reads it has when a follow read fails and logs ids only', async () => {
      const readLogLines = spyOnEveryLogLine();
      const remote = await attachedRemote(harness, 'socket-remote');
      serveSetlistReads(harness.reads, 3);
      await harness.gateway.handleSetlistSelect(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        setlistId: SETLIST_ID,
        index: 2,
      });
      await flushImmediate();
      harness.roomEmits.length = 0;
      harness.reads.readSetlistFollow.mockRejectedValueOnce(
        new Error('read failed near SECRET-SETLIST-NAME'),
      );

      await harness.gateway.handleLibraryChanged(
        libraryChange({
          kind: 'scene_deleted',
          sceneId: SCENE_ID,
          setlistIds: [SETLIST_ID],
        }),
      );
      await flushImmediate();

      expect(stageFrames(harness)).toEqual([]);
      expect(harness.stages.getState(ADMIN_USER_ID)?.setlistIndex).toBe(2);
      const logged = readLogLines();
      expect(
        logged.some(
          (line) => line.includes('scene_deleted') && line.includes(SETLIST_ID),
        ),
      ).toBe(true);
      expect(logged.some((line) => line.includes('SECRET-SETLIST-NAME'))).toBe(
        false,
      );
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
      expect(stageFrames(harness)).toEqual([]);
      await flushImmediate();

      const frames = stageFrames(harness);
      expect(frames).toHaveLength(1);
      const frame = payloadOf(frames[0]);
      expect(frame.cause).toBe('strobe_timeout');
      expect(frame.state.effects.isStrobing).toBe(false);
      expect(frame.state.effects.strobeStartedAt).toBeNull();
    });

    it('never logs overlay text from a refused frame', async () => {
      const readLogLines = spyOnEveryLogLine();
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
      const logged = readLogLines();
      expect(
        logged.some((line) => line.includes('vj_overlay_text_invalid')),
      ).toBe(true);
      expect(logged.some((line) => line.includes('SECRET LINE'))).toBe(false);
    });

    it('never logs a countdown label or a scene payload', async () => {
      const readLogLines = spyOnEveryLogLine();
      const remote = await attachedRemote(harness, 'socket-remote');

      const countdown = await harness.gateway.handleSetCountdown(
        asClient(remote),
        {
          clientId: CLIENT_ID,
          commandSequence: 1,
          isVisible: true,
          durationMs: 60_000,
          label: 'SECRET LABEL\nSECOND LINE',
        },
      );
      const recall = await harness.gateway.handleRecallScene(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 2,
        sceneId: 'SECRET SCENE NAME',
      });
      await flushImmediate();

      expect(codeOf(countdown)).toBe('vj_countdown_label_invalid');
      expect(codeOf(recall)).toBe('vj_scene_not_found');
      const logged = readLogLines();
      expect(
        logged.some((line) => line.includes('vj_countdown_label_invalid')),
      ).toBe(true);
      expect(logged.some((line) => line.includes('vj_scene_not_found'))).toBe(
        true,
      );
      expect(logged.some((line) => line.includes('SECRET LABEL'))).toBe(false);
      expect(logged.some((line) => line.includes('SECRET SCENE'))).toBe(false);
    });
  });

  describe('clock sync, identify and serverNow', () => {
    it('answers clock:sync before attach and refuses the 11th in a burst', async () => {
      const client = await connect(harness, 'socket-fresh');

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        expect(
          await harness.gateway.handleClockSync(asClient(client), {}),
        ).toEqual({ ok: true, serverNow: START });
      }
      const eleventh = await harness.gateway.handleClockSync(
        asClient(client),
        {},
      );

      expect(codeOf(eleventh)).toBe('vj_rate_limited');
      expect(eleventh.serverNow).toBe(START);
      expect(client.data.role).toBeUndefined();
      expect(harness.stages.getState(ADMIN_USER_ID)).toBeNull();
    });

    it('acks vj_not_admin to a demoted admin on clock:sync', async () => {
      const client = await connect(harness, 'socket-fresh');
      harness.roleByUserId.set(ADMIN_USER_ID, UserRole.Member);
      jest.advanceTimersByTime(VJ_ROLE_RECHECK_MS);

      const ack = await harness.gateway.handleClockSync(asClient(client), {});

      expect(ack).toEqual({
        ok: false,
        code: 'vj_not_admin',
        message: VJ_NOT_ADMIN_MESSAGE,
        serverNow: Date.now(),
      });
      await flushImmediate();
      expect(clientEmits(client, 'exception')).toEqual([
        expect.objectContaining({
          code: 'FORBIDDEN',
          domainCode: 'vj_not_admin',
        }),
      ]);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('answers clock:sync while a slow command holds the queue', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      harness.reads.existingClipIds.mockImplementationOnce(
        () => new Promise<Set<string>>(() => undefined),
      );
      void harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        clipId: CLIP_ID,
      });
      await flushImmediate();

      expect(
        await harness.gateway.handleClockSync(asClient(remote), {}),
      ).toEqual({ ok: true, serverNow: START });
    });

    it('relays screen:identify to one screen or to every screen', async () => {
      const first = await attachedScreen(harness, 'socket-first');
      const second = await attachedScreen(
        harness,
        'socket-second',
        OTHER_SCREEN_ID,
      );
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();
      harness.roomEmits.length = 0;

      const one = await harness.gateway.handleScreenIdentify(asClient(remote), {
        screenId: OTHER_SCREEN_ID.toUpperCase(),
      });

      expect(one).toEqual({ ok: true, identifiedCount: 1, serverNow: START });
      // Nothing leaves before the ack.
      expect(roomEmitsOf(harness, 'screen:identify')).toEqual([]);
      await flushImmediate();
      expect(roomEmitsOf(harness, 'screen:identify')).toEqual([
        {
          room: second.id,
          event: 'screen:identify',
          payload: { number: 2, durationMs: VJ_LIMITS.identifyDurationMs },
        },
      ]);
      harness.roomEmits.length = 0;

      const every = await harness.gateway.handleScreenIdentify(
        asClient(remote),
        { screenId: null },
      );

      expect(every).toEqual({ ok: true, identifiedCount: 2, serverNow: START });
      await flushImmediate();
      expect(roomEmitsOf(harness, 'screen:identify')).toEqual([
        {
          room: first.id,
          event: 'screen:identify',
          payload: { number: 1, durationMs: VJ_LIMITS.identifyDurationMs },
        },
        {
          room: second.id,
          event: 'screen:identify',
          payload: { number: 2, durationMs: VJ_LIMITS.identifyDurationMs },
        },
      ]);
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);
    });

    it('answers vj_wrong_role to identify from a screen', async () => {
      const screen = await attachedScreen(harness, 'socket-screen');

      const ack = await harness.gateway.handleScreenIdentify(asClient(screen), {
        screenId: null,
      });

      expect(codeOf(ack)).toBe('vj_wrong_role');
    });

    it('answers vj_screen_not_attached for an offline screen', async () => {
      await attachedScreen(harness, 'socket-online');
      const offline = await attachedScreen(
        harness,
        'socket-offline',
        OTHER_SCREEN_ID,
      );
      const remote = await attachedRemote(harness, 'socket-remote');
      offline.connected = false;
      harness.gateway.handleDisconnect(asClient(offline));
      await flushImmediate();
      harness.roomEmits.length = 0;

      const ack = await harness.gateway.handleScreenIdentify(asClient(remote), {
        screenId: OTHER_SCREEN_ID,
      });

      expect(codeOf(ack)).toBe('vj_screen_not_attached');
      await flushImmediate();
      expect(roomEmitsOf(harness, 'screen:identify')).toEqual([]);
    });

    it('refuses the 6th identify in a burst', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const ack = await harness.gateway.handleScreenIdentify(
          asClient(remote),
          { screenId: null },
        );
        expect(ack.ok).toBe(true);
      }

      const sixth = await harness.gateway.handleScreenIdentify(
        asClient(remote),
        { screenId: null },
      );
      expect(codeOf(sixth)).toBe('vj_rate_limited');
    });

    it('relays screens:setRenderMode to every connected screen on the next tick', async () => {
      const first = await attachedScreen(harness, 'socket-first');
      const second = await attachedScreen(
        harness,
        'socket-second',
        OTHER_SCREEN_ID,
      );
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();
      harness.roomEmits.length = 0;

      const ack = await harness.gateway.handleSetRenderMode(asClient(remote), {
        mode: 'simple',
      });

      expect(ack).toEqual({ ok: true, reachedCount: 2, serverNow: START });
      // Nothing leaves before the ack.
      expect(roomEmitsOf(harness, 'screen:renderMode')).toEqual([]);
      await flushImmediate();
      expect(roomEmitsOf(harness, 'screen:renderMode')).toEqual([
        {
          room: first.id,
          event: 'screen:renderMode',
          payload: { mode: 'simple' },
        },
        {
          room: second.id,
          event: 'screen:renderMode',
          payload: { mode: 'simple' },
        },
      ]);
      expect(harness.stages.getState(ADMIN_USER_ID)?.revision).toBe(0);
    });

    it('answers vj_wrong_role to setRenderMode from a screen', async () => {
      const screen = await attachedScreen(harness, 'socket-screen');

      const ack = await harness.gateway.handleSetRenderMode(asClient(screen), {
        mode: 'simple',
      });

      expect(codeOf(ack)).toBe('vj_wrong_role');
    });

    it('answers vj_render_mode_invalid for a mode outside the list', async () => {
      await attachedScreen(harness, 'socket-screen');
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();
      harness.roomEmits.length = 0;

      for (const mode of ['webgl2', null, 7]) {
        const ack = await harness.gateway.handleSetRenderMode(
          asClient(remote),
          { mode },
        );
        expect(codeOf(ack)).toBe('vj_render_mode_invalid');
      }

      await flushImmediate();
      expect(roomEmitsOf(harness, 'screen:renderMode')).toEqual([]);
    });

    it('answers vj_no_screens_connected with no screen connected', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      await flushImmediate();
      harness.roomEmits.length = 0;

      const ack = await harness.gateway.handleSetRenderMode(asClient(remote), {
        mode: 'effects',
      });

      expect(codeOf(ack)).toBe('vj_no_screens_connected');
      await flushImmediate();
      expect(roomEmitsOf(harness, 'screen:renderMode')).toEqual([]);
    });

    it('refuses the sixth setRenderMode in a burst with vj_rate_limited', async () => {
      await attachedScreen(harness, 'socket-screen');
      const remote = await attachedRemote(harness, 'socket-remote');

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const ack = await harness.gateway.handleSetRenderMode(
          asClient(remote),
          { mode: 'simple' },
        );
        expect(ack.ok).toBe(true);
      }

      const sixth = await harness.gateway.handleSetRenderMode(
        asClient(remote),
        { mode: 'simple' },
      );
      expect(codeOf(sixth)).toBe('vj_rate_limited');
    });

    const SENT_AT = START + 1234;

    /** Each frame with an ack: the setup, then `markSent` right before the
     *  frame goes, so the ack's clock is the one read at return. */
    const ackCases: [
      string,
      (harness: Harness, markSent: () => void) => Promise<object>,
    ][] = [
      [
        'attach',
        async (subject, markSent) => {
          const client = await connect(subject, 'socket-attach');
          markSent();
          return attachRemote(subject, client);
        },
      ],
      [
        'reauth',
        async (subject, markSent) => {
          const client = await connect(subject, 'socket-reauth');
          const { ticket } = socketTicketService.mint(
            ADMIN_USER_ID,
            `family-${ADMIN_USER_ID}`,
            UserStatus.Active,
            15 * 60_000,
          );
          markSent();
          return subject.gateway.handleReauth(asClient(client), { ticket });
        },
      ],
      [
        'clock sync',
        async (subject, markSent) => {
          const client = await connect(subject, 'socket-clock');
          markSent();
          return subject.gateway.handleClockSync(asClient(client), {});
        },
      ],
      [
        'a command success',
        async (subject, markSent) => {
          const remote = await attachedRemote(subject, 'socket-remote');
          markSent();
          return setBlackout(subject, remote, 1, true);
        },
      ],
      [
        'a command refusal',
        async (subject, markSent) => {
          const remote = await attachedRemote(subject, 'socket-remote');
          markSent();
          return subject.gateway.handleSetEffects(asClient(remote), {
            clientId: CLIENT_ID,
            commandSequence: 1,
            speed: 3,
          });
        },
      ],
      [
        'advance',
        async (subject, markSent) => {
          const screen = await attachedScreen(subject, 'socket-screen');
          markSent();
          return subject.gateway.handleScreenAdvance(asClient(screen), {
            expectedClipSequence: 0,
            clipId: CLIP_ID,
          });
        },
      ],
      [
        'identify',
        async (subject, markSent) => {
          const remote = await attachedRemote(subject, 'socket-remote');
          markSent();
          return subject.gateway.handleScreenIdentify(asClient(remote), {
            screenId: null,
          });
        },
      ],
    ];

    it.each(ackCases)(
      'puts serverNow on every ack: %s',
      async (_name, send) => {
        const ack = await send(harness, () => {
          jest.setSystemTime(SENT_AT);
        });

        expect(ack).toMatchObject({ serverNow: SENT_AT });
      },
    );

    it('stamps serverNow when a refusal leaves, past the time it was built', async () => {
      const remote = await attachedRemote(harness, 'socket-remote');
      jest.spyOn(harness.stages, 'runRemoteCommand').mockResolvedValueOnce({
        ok: false,
        failure: { ...vjAckFailure('vj_clip_not_found'), serverNow: 1 },
      });
      jest.setSystemTime(SENT_AT);

      const ack = await harness.gateway.handleGoClip(asClient(remote), {
        clientId: CLIENT_ID,
        commandSequence: 1,
        clipId: CLIP_ID,
      });

      expect(ack).toMatchObject({
        ok: false,
        code: 'vj_clip_not_found',
        serverNow: SENT_AT,
      });
    });
  });
});
