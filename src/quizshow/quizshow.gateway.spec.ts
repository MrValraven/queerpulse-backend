import { Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Namespace } from 'socket.io';
import type { Repository } from 'typeorm';
import type { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import { ChatWsException } from '../chat/ws-error';
import { BLOCKED_TERMS } from '../common/blocked-terms';
import type { Event } from '../events/entities/event.entity';
import { EventStatus } from '../events/entities/event.entity';
import type { EventBan } from '../events/entities/event-ban.entity';
import type { EventsService } from '../events/events.service';
import * as launchedFeatures from '../launchedFeatures';
import type { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import type { BlockFilterService } from '../social/block-filter.service';
import type { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import type { QuizshowAnswerPayloadDto } from './dto/quizshow-socket-payloads';
import type { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import type { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowAccessService } from './quizshow-access.service';
import type {
  QuizshowAck,
  QuizshowAttachRole,
  QuizshowMe,
} from './quizshow.contract';
import { createLobbyState } from './quizshow-engine-state';
import type {
  QuizshowLiveState,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import * as quizshowFrames from './quizshow-frames';
import { quizshowPlayerRoomName, quizshowRoomName } from './quizshow-frames';
import { QuizshowGateway } from './quizshow.gateway';
import type { QuizshowPersistenceService } from './quizshow-persistence.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import type {
  QuizshowRandom,
  QuizshowSnapshotQuestion,
} from './quizshow-snapshot';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const QUESTION_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = 'event-1';
const HOST_USER_ID = 'host-user';
const COHOST_USER_ID = 'cohost-user';
const PLAYER_USER_ID = 'player-user';
const OUTSIDER_USER_ID = 'outsider-user';
const STRANGER_USER_ID = 'stranger-user';
const BLOCKED_WORD = BLOCKED_TERMS[0] ?? 'blocked';
const START = Date.UTC(2026, 9, 19, 20, 0, 0);
const OPEN_STATUSES = new Set(['lobby', 'running', 'paused']);

type GatewayClient = Parameters<QuizshowGateway['handleConnection']>[0];

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
  leave: jest.Mock;
  disconnect: jest.Mock;
}

interface RoomEmit {
  room: string;
  event: string;
  payload: unknown;
}

interface Harness {
  gateway: QuizshowGateway;
  /** The namespace's socket map: connected fake sockets by id. */
  sockets: Map<string, FakeClient>;
  runtime: QuizshowRuntimeService;
  state: QuizshowLiveState;
  roomEmits: RoomEmit[];
  organiserUserIds: Set<string>;
  hiddenFromUserIds: Set<string>;
  persistence: {
    loadLiveState: jest.Mock;
    enqueue: jest.Mock;
    enqueueBatch: jest.Mock;
    flush: jest.Mock;
    flushAll: jest.Mock;
    isOpenSessionIdle: jest.Mock;
  };
  eventsService: { isOrganizer: jest.Mock; assertCanView: jest.Mock };
  profiles: { findOne: jest.Mock };
  refreshTokens: { exists: jest.Mock };
  jwt: { verifyAsync: jest.Mock };
}

function deterministicRandom(): QuizshowRandom {
  let counter = 0;
  return {
    uuid: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    integerBelow: () => 0,
  };
}

function trueFalseQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'true_false',
    prompt: { en: 'Is it true?', pt: 'É verdade?' },
    mediaRef: null,
    mediaUrl: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: { isTrue: true },
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function typedQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'type_answer',
    prompt: { en: 'Name the bar', pt: 'Diz o nome do bar' },
    mediaRef: null,
    mediaUrl: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: { text: { en: 'Stonewall Inn', pt: 'Stonewall Inn' } },
    acceptedAnswers: ['Stonewall'],
    shownOptions: null,
  };
}

function lobbyState(): QuizshowLiveState {
  return createLobbyState({
    sessionId: SESSION_ID,
    eventId: EVENT_ID,
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: HOST_USER_ID,
    openedByUserId: HOST_USER_ID,
    joinCode: 'ABC234',
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: false,
    snapshot: {
      title: 'Pride night quiz',
      languages: 'both',
      screenLanguage: 'en',
      rounds: [
        {
          id: 'round-1',
          kind: 'quiz',
          title: { en: 'Round', pt: 'Ronda' },
          contentLabel: 'none',
          settings: {
            timeLimitSeconds: 20,
            isSpeedBonusOn: true,
            isJokerAllowed: true,
            writeSeconds: 60,
            voteSeconds: 30,
          },
          questions: [
            typedQuestion(QUESTION_ID),
            trueFalseQuestion('33333333-3333-4333-8333-333333333333'),
          ],
        },
      ],
    },
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: START,
  });
}

function createHarness(): Harness {
  const state = lobbyState();
  const persistence = {
    loadLiveState: jest.fn((sessionId: string) =>
      Promise.resolve(
        sessionId === SESSION_ID && OPEN_STATUSES.has(state.status)
          ? state
          : null,
      ),
    ),
    enqueue: jest.fn(),
    enqueueBatch: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
    flushAll: jest.fn(() => Promise.resolve()),
    isOpenSessionIdle: jest.fn(() => Promise.resolve(false)),
  };
  const runtime = new QuizshowRuntimeService(
    persistence as unknown as QuizshowPersistenceService,
    deterministicRandom(),
  );
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
    in: () => ({ socketsLeave: () => undefined }),
    disconnectSockets: jest.fn(),
  } as unknown as Namespace;

  const organiserUserIds = new Set<string>([HOST_USER_ID, COHOST_USER_ID]);
  const hiddenFromUserIds = new Set<string>();
  const eventsService = {
    isOrganizer: jest.fn((_eventId: string, userId: string) =>
      Promise.resolve(organiserUserIds.has(userId)),
    ),
    assertCanView: jest.fn((_event: Event, userId: string) =>
      hiddenFromUserIds.has(userId)
        ? Promise.reject(new NotFoundException('Event not found'))
        : Promise.resolve(organiserUserIds.has(userId)),
    ),
  };
  const event = {
    id: EVENT_ID,
    hostId: HOST_USER_ID,
    slug: 'pride-night',
    status: EventStatus.Published,
    formatDetails: null,
  } as unknown as Event;
  const events = { findOne: jest.fn(() => Promise.resolve(event)) };
  const users = {
    findOne: jest.fn((options: { where: { id: string } }) =>
      Promise.resolve({
        id: options.where.id,
        role: UserRole.Member,
        status: UserStatus.Active,
        restricted: false,
        restrictedUntil: null,
      }),
    ),
  };
  const profiles = {
    findOne: jest.fn(() =>
      Promise.resolve({
        userId: PLAYER_USER_ID,
        firstName: '  Robin  ',
        avatarUrl: null,
        photoVisible: false,
      }),
    ),
  };
  const refreshTokens = { exists: jest.fn(() => Promise.resolve(true)) };
  const sessionRows = { findOne: jest.fn(() => Promise.resolve(null)) };
  const platformSettings = {
    get: jest.fn(() =>
      Promise.resolve({
        lockdownEnabled: false,
        lockdownAllowsModerators: false,
        lockdownMessage: null,
      }),
    ),
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
  const access = new QuizshowAccessService(
    events as unknown as Repository<Event>,
    {
      exists: jest.fn(() => Promise.resolve(false)),
    } as unknown as Repository<EventBan>,
    users as unknown as Repository<User>,
    {
      find: jest.fn(() => Promise.resolve([])),
    } as unknown as Repository<QuizshowSessionRecord>,
    {
      findOne: jest.fn(() => Promise.resolve(null)),
      count: jest.fn(() => Promise.resolve(0)),
      exists: jest.fn(() => Promise.resolve(false)),
    } as unknown as Repository<QuizshowPlayerRecord>,
    eventsService as unknown as EventsService,
    {
      isBlockedEitherWay: jest.fn(() => Promise.resolve(false)),
    } as unknown as BlockFilterService,
  );
  const gateway = new QuizshowGateway(
    jwt as unknown as JwtService,
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
    runtime,
    access,
    eventsService as unknown as EventsService,
    users as unknown as Repository<User>,
    profiles as unknown as Repository<Profile>,
    refreshTokens as unknown as Repository<RefreshToken>,
    events as unknown as Repository<Event>,
    sessionRows as unknown as Repository<QuizshowSessionRecord>,
    platformSettings as unknown as PlatformSettingsService,
  );
  gateway.namespace = namespace;
  gateway.afterInit(namespace);
  return {
    gateway,
    sockets,
    runtime,
    state,
    roomEmits,
    organiserUserIds,
    hiddenFromUserIds,
    persistence,
    eventsService,
    profiles,
    refreshTokens,
    jwt,
  };
}

function makeClient(socketId: string, userId: string): FakeClient {
  const client: FakeClient = {
    id: socketId,
    connected: true,
    handshake: { auth: { token: userId }, headers: {} },
    data: {},
    emit: jest.fn(),
    join: jest.fn(() => Promise.resolve()),
    leave: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(() => {
      client.connected = false;
    }),
  };
  return client;
}

function asClient(client: FakeClient): GatewayClient {
  return client as unknown as GatewayClient;
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function codeOf(ack: QuizshowAck<object>): string | null {
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

async function connect(
  harness: Harness,
  socketId: string,
  userId: string,
): Promise<FakeClient> {
  const client = makeClient(socketId, userId);
  harness.sockets.set(socketId, client);
  client.disconnect.mockImplementation(() => {
    client.connected = false;
    harness.sockets.delete(socketId);
  });
  await harness.gateway.handleConnection(asClient(client));
  return client;
}

function attach(
  harness: Harness,
  client: FakeClient,
  role: QuizshowAttachRole,
) {
  return harness.gateway.handleAttach(asClient(client), {
    sessionId: SESSION_ID,
    as: role,
  });
}

function joinLobby(
  harness: Harness,
  client: FakeClient,
  screenName = 'Robin',
): Promise<QuizshowAck<{ me: QuizshowMe }>> {
  return harness.gateway.handleLobbyJoin(asClient(client), {
    screenName,
    isAvatarShown: false,
    hasExtraTime: false,
    team: null,
  });
}

function submitAnswer(
  harness: Harness,
  client: FakeClient,
  payload: object = { type: 'true_false', isTrue: true },
  phaseId = '0',
) {
  return harness.gateway.handleAnswerSubmit(asClient(client), {
    phaseId,
    questionId: QUESTION_ID,
    payload: payload as QuizshowAnswerPayloadDto,
  });
}

function hostNext(harness: Harness, client: FakeClient, phaseId: string) {
  return harness.gateway.handleHostNext(asClient(client), {
    phaseId,
  });
}

function setScreenMuted(
  harness: Harness,
  client: FakeClient,
  isMuted: boolean,
) {
  return harness.gateway.handleHostSetScreenMuted(asClient(client), {
    isMuted,
  });
}

/** A connected socket attached as a player who joined the lobby. */
async function joinedPlayer(
  harness: Harness,
  socketId: string,
  userId: string,
  screenName = 'Robin',
): Promise<{ client: FakeClient; me: QuizshowMe }> {
  const client = await connect(harness, socketId, userId);
  expect(await attach(harness, client, 'player')).toMatchObject({ ok: true });
  const ack = await joinLobby(harness, client, screenName);
  if (!ack.ok) throw new Error(`lobby:join refused with ${ack.code}`);
  return { client, me: ack.me };
}

async function attachedHost(
  harness: Harness,
  socketId: string,
  userId: string = HOST_USER_ID,
): Promise<FakeClient> {
  const client = await connect(harness, socketId, userId);
  expect(await attach(harness, client, 'host')).toMatchObject({ ok: true });
  return client;
}

describe('QuizshowGateway', () => {
  let harness: Harness;

  beforeEach(() => {
    jest.spyOn(launchedFeatures, 'isFeatureLaunched').mockReturnValue(true);
    harness = createHarness();
  });

  afterEach(() => {
    harness.runtime.onModuleDestroy();
    harness.gateway.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('refuses every handshake with NOT_FOUND while Pulse Live is hidden', async () => {
    jest.spyOn(launchedFeatures, 'isFeatureLaunched').mockReturnValue(false);
    const memberClient = await connect(harness, 'socket-1', PLAYER_USER_ID);
    const tokenlessClient = makeClient('socket-2', HOST_USER_ID);
    tokenlessClient.handshake.auth = {};
    await harness.gateway.handleConnection(asClient(tokenlessClient));

    for (const client of [memberClient, tokenlessClient]) {
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'NOT_FOUND',
        message: 'This feature is not available yet.',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
    }
    expect(harness.jwt.verifyAsync).not.toHaveBeenCalled();
    await expect(attach(harness, memberClient, 'player')).rejects.toThrow(
      ChatWsException,
    );
  });

  it("admits a signed-in member with a live session and drops the socket at the token's expiry with TOKEN_EXPIRED", async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    harness.jwt.verifyAsync.mockImplementation((token: string) =>
      Promise.resolve({
        sub: token,
        status: UserStatus.Active,
        exp: Math.floor(Date.now() / 1000) + 60,
        sid: `family-${token}`,
      }),
    );
    const client = await connect(harness, 'socket-1', PLAYER_USER_ID);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.data.userId).toBe(PLAYER_USER_ID);
    expect(harness.refreshTokens.exists).toHaveBeenCalledWith({
      where: expect.objectContaining({
        familyId: `family-${PLAYER_USER_ID}`,
      }) as unknown,
    });

    jest.advanceTimersByTime(58_000);
    expect(client.disconnect).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2_000);
    expect(client.emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({ status: 'error', code: 'TOKEN_EXPIRED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it("extends a socket with a socket ticket and drops one presenting another member's ticket", async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    harness.jwt.verifyAsync.mockImplementation((token: string) =>
      Promise.resolve({
        sub: token,
        status: UserStatus.Active,
        exp: Math.floor(Date.now() / 1000) + 60,
        sid: `family-${token}`,
      }),
    );
    const client = await connect(harness, 'socket-1', PLAYER_USER_ID);
    const handshakeExp = client.data.exp as number;

    const { ticket } = socketTicketService.mint(
      PLAYER_USER_ID,
      `family-${PLAYER_USER_ID}`,
      UserStatus.Active,
      15 * 60_000,
    );
    const extended = await harness.gateway.handleReauth(asClient(client), {
      ticket,
    });
    expect(extended.ok).toBe(true);
    if (!extended.ok) return;
    expect(extended.exp).toBeGreaterThan(handshakeExp);
    expect(client.data.exp).toBe(extended.exp);

    jest.advanceTimersByTime(120_000);
    expect(client.disconnect).not.toHaveBeenCalled();

    const stranger = socketTicketService.mint(
      STRANGER_USER_ID,
      `family-${STRANGER_USER_ID}`,
      UserStatus.Active,
      15 * 60_000,
    );
    const refused = await harness.gateway.handleReauth(asClient(client), {
      ticket: stranger.ticket,
    });
    expect(refused).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(client.emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a host attach from a co-host who joined as a player', async () => {
    const { me } = await joinedPlayer(harness, 'socket-phone', COHOST_USER_ID);
    expect(me.isCohostPlayer).toBe(true);

    const laptop = await connect(harness, 'socket-laptop', COHOST_USER_ID);
    expect(codeOf(await attach(harness, laptop, 'host'))).toBe(
      'quizshow_cohost_is_playing',
    );
    expect(codeOf(await attach(harness, laptop, 'screen'))).toBe(
      'quizshow_cohost_is_playing',
    );
    expect(laptop.data.role).toBeUndefined();
    expect(harness.state.attachedOrganiserUserIds.has(COHOST_USER_ID)).toBe(
      false,
    );

    const hostRemote = await connect(harness, 'socket-host', HOST_USER_ID);
    expect(await attach(harness, hostRemote, 'host')).toMatchObject({
      ok: true,
      role: 'host',
    });
  });

  it('refuses a player attach from someone who cannot view the event with cannot view event', async () => {
    harness.hiddenFromUserIds.add(OUTSIDER_USER_ID);
    const client = await connect(harness, 'socket-1', OUTSIDER_USER_ID);

    expect(codeOf(await attach(harness, client, 'player'))).toBe(
      'quizshow_cannot_view_event',
    );
    // The refused attach released its claim, so another try is judged afresh.
    expect(codeOf(await attach(harness, client, 'player'))).toBe(
      'quizshow_cannot_view_event',
    );
    expect(codeOf(await attach(harness, client, 'screen'))).toBe(
      'quizshow_session_not_found',
    );
    expect(client.join).not.toHaveBeenCalled();
  });

  it('refuses a second attach and any frame before attach', async () => {
    const hostRemote = await attachedHost(harness, 'socket-host');
    expect(codeOf(await attach(harness, hostRemote, 'screen'))).toBe(
      'quizshow_already_attached',
    );
    expect(hostRemote.data.role).toBe('host');

    const unattached = await connect(harness, 'socket-2', PLAYER_USER_ID);
    expect(codeOf(await joinLobby(harness, unattached))).toBe(
      'quizshow_not_attached',
    );
    expect(codeOf(await submitAnswer(harness, unattached))).toBe(
      'quizshow_not_attached',
    );
    expect(codeOf(await hostNext(harness, unattached, '0'))).toBe(
      'quizshow_not_attached',
    );
    expect(codeOf(await setScreenMuted(harness, unattached, true))).toBe(
      'quizshow_not_attached',
    );
  });

  it('refuses a player frame on a host socket', async () => {
    const hostRemote = await attachedHost(harness, 'socket-host');
    expect(codeOf(await joinLobby(harness, hostRemote))).toBe(
      'quizshow_wrong_role',
    );
    expect(codeOf(await submitAnswer(harness, hostRemote))).toBe(
      'quizshow_wrong_role',
    );

    const screen = await connect(harness, 'socket-screen', HOST_USER_ID);
    expect(await attach(harness, screen, 'screen')).toMatchObject({
      ok: true,
    });
    expect(codeOf(await hostNext(harness, screen, '0'))).toBe(
      'quizshow_wrong_role',
    );

    const { client: player } = await joinedPlayer(
      harness,
      'socket-player',
      PLAYER_USER_ID,
    );
    expect(codeOf(await hostNext(harness, player, '0'))).toBe(
      'quizshow_wrong_role',
    );
    expect(harness.state.cursor.phase).toBe('lobby');
  });

  it('emits session state after the attach ack', async () => {
    const screen = await connect(harness, 'socket-screen', HOST_USER_ID);
    const screenAck = await attach(harness, screen, 'screen');
    expect(screenAck).toEqual({
      ok: true,
      role: 'screen',
      connectionExpiresAt: (screen.data.exp as number) * 1000,
    });
    expect(clientEmits(screen, 'session:state')).toHaveLength(0);
    await flushImmediate();
    expect(clientEmits(screen, 'session:state')).toEqual([
      expect.objectContaining({ role: 'screen' }),
    ]);

    const player = await connect(harness, 'socket-player', PLAYER_USER_ID);
    expect(await attach(harness, player, 'player')).toMatchObject({
      ok: true,
      role: 'player',
    });
    expect(clientEmits(player, 'session:state')).toHaveLength(0);
    await flushImmediate();
    expect(clientEmits(player, 'session:state')).toEqual([
      expect.objectContaining({
        role: 'player',
        me: null,
        suggestedScreenName: 'Robin',
      }),
    ]);

    harness.profiles.findOne.mockResolvedValueOnce({
      userId: OUTSIDER_USER_ID,
      firstName: BLOCKED_WORD,
      avatarUrl: null,
      photoVisible: false,
    });
    const blockedName = await connect(harness, 'socket-3', OUTSIDER_USER_ID);
    await attach(harness, blockedName, 'player');
    await flushImmediate();
    expect(clientEmits(blockedName, 'session:state')).toEqual([
      expect.objectContaining({ suggestedScreenName: '' }),
    ]);
  });

  it("creates the player row before acking lobby join and re-sends the state to the player's room", async () => {
    const client = await connect(harness, 'socket-1', PLAYER_USER_ID);
    await attach(harness, client, 'player');
    await flushImmediate();

    const ack = await joinLobby(harness, client);
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    const { me } = ack;
    expect(me.screenName).toBe('Robin');

    // The runtime queues every write of one command as one batch.
    const insertCall =
      harness.persistence.enqueueBatch.mock.invocationCallOrder[
        harness.persistence.enqueueBatch.mock.calls.findIndex(
          (call: unknown[]) =>
            (call[1] as readonly QuizshowPersistOperation[]).some(
              (operation) => operation.type === 'insert_player',
            ),
        )
      ];
    const flushCall = harness.persistence.flush.mock.invocationCallOrder[0];
    expect(insertCall).toBeDefined();
    expect(flushCall).toBeDefined();
    expect(insertCall as number).toBeLessThan(flushCall as number);
    expect(harness.persistence.flush).toHaveBeenCalledWith(SESSION_ID);

    const playerRoom = quizshowPlayerRoomName(SESSION_ID, me.playerId);
    expect(client.join).toHaveBeenCalledWith(playerRoom);
    expect(client.data.playerId).toBe(me.playerId);
    expect(harness.state.players.get(me.playerId)?.connectedSocketCount).toBe(
      1,
    );

    const roomStates = () =>
      roomEmitsOf(harness, 'session:state').filter(
        (record) => record.room === playerRoom,
      );
    expect(roomStates()).toHaveLength(0);
    await flushImmediate();
    expect(roomStates()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          role: 'player',
          me: expect.objectContaining({ playerId: me.playerId }) as unknown,
        }) as unknown,
      }),
    ]);

    const repeat = await joinLobby(harness, client, 'Another name');
    expect(repeat).toEqual({ ok: true, me });
  });

  it('logs only a code and the session id when a session state builder throws after the ack', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const screen = await connect(harness, 'socket-screen', HOST_USER_ID);
    const player = await connect(harness, 'socket-player', PLAYER_USER_ID);
    const secretDetail = 'Robin wrote Stonewall Inn';
    jest.spyOn(quizshowFrames, 'buildSessionState').mockImplementation(() => {
      throw new TypeError(secretDetail);
    });

    expect(await attach(harness, screen, 'screen')).toMatchObject({
      ok: true,
    });
    await expect(flushImmediate()).resolves.toBeUndefined();
    expect(clientEmits(screen, 'session:state')).toHaveLength(0);

    expect(await attach(harness, player, 'player')).toMatchObject({
      ok: true,
    });
    await flushImmediate();
    const joinAck = await joinLobby(harness, player);
    expect(joinAck.ok).toBe(true);
    await expect(flushImmediate()).resolves.toBeUndefined();
    expect(roomEmitsOf(harness, 'session:state')).toHaveLength(0);
    expect(clientEmits(player, 'session:state')).toHaveLength(0);

    const failureLines = errorSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line) => line.includes('session:state frame failed'));
    const expectedLine = `Pulse Live session:state frame failed for session ${SESSION_ID}: TypeError`;
    expect(failureLines).toEqual([expectedLine, expectedLine, expectedLine]);
    const everyLoggedValue = errorSpy.mock.calls
      .flat()
      .map((value: unknown) => String(value))
      .join('\n');
    expect(everyLoggedValue).not.toContain(secretDetail);
    expect(everyLoggedValue).not.toContain('Robin');
  });

  it('refuses a removed player on attach and on lobby join', async () => {
    const hostRemote = await attachedHost(harness, 'socket-host');
    // The laptop attaches before the phone joins: the join binds it too.
    const laptop = await connect(harness, 'socket-laptop', PLAYER_USER_ID);
    await attach(harness, laptop, 'player');
    expect(laptop.data.playerId).toBeNull();
    const { me } = await joinedPlayer(harness, 'socket-phone', PLAYER_USER_ID);
    expect(laptop.data.playerId).toBe(me.playerId);
    expect(laptop.join).toHaveBeenCalledWith(
      quizshowPlayerRoomName(SESSION_ID, me.playerId),
    );
    expect(harness.state.players.get(me.playerId)?.connectedSocketCount).toBe(
      2,
    );

    const removal = await harness.gateway.handleHostRemovePlayer(
      asClient(hostRemote),
      { playerId: me.playerId },
    );
    expect(removal).toEqual({ ok: true, isNoop: false });

    const tablet = await connect(harness, 'socket-tablet', PLAYER_USER_ID);
    expect(codeOf(await attach(harness, tablet, 'player'))).toBe(
      'quizshow_player_removed',
    );
    expect(codeOf(await joinLobby(harness, laptop))).toBe(
      'quizshow_player_removed',
    );
  });

  it('lets exactly one of a racing host attach and lobby join from a co-host win', async () => {
    const phone = await connect(harness, 'socket-phone', COHOST_USER_ID);
    await attach(harness, phone, 'player');
    const laptop = await connect(harness, 'socket-laptop', COHOST_USER_ID);

    const [attachAck, joinAck] = await Promise.all([
      attach(harness, laptop, 'host'),
      joinLobby(harness, phone),
    ]);

    expect([attachAck.ok, joinAck.ok].filter(Boolean)).toHaveLength(1);
    expect(codeOf(attachAck) ?? codeOf(joinAck)).toMatch(
      /^quizshow_(cohost_is_playing|organiser_running)$/,
    );
    const isAttachedOrganiser =
      harness.state.attachedOrganiserUserIds.has(COHOST_USER_ID);
    const isPlaying = [...harness.state.players.values()].some(
      (player) => player.userId === COHOST_USER_ID && player.removedAt === null,
    );
    expect(isAttachedOrganiser).not.toBe(isPlaying);
  });

  it('re-checks the co-host on the current state inside the attach and the lobby join', async () => {
    // A lobby:join whose checks passed before a host attach landed is refused.
    const phone = await connect(harness, 'socket-phone', COHOST_USER_ID);
    await attach(harness, phone, 'player');
    let releaseProfile: () => void = () => undefined;
    const profileGate = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    let markProfileReached: () => void = () => undefined;
    const profileReached = new Promise<void>((resolve) => {
      markProfileReached = resolve;
    });
    harness.profiles.findOne.mockImplementationOnce(async () => {
      markProfileReached();
      await profileGate;
      return {
        userId: COHOST_USER_ID,
        firstName: 'Robin',
        avatarUrl: null,
        photoVisible: false,
      };
    });
    const joining = joinLobby(harness, phone);
    await profileReached;
    const laptop = await connect(harness, 'socket-laptop', COHOST_USER_ID);
    expect(await attach(harness, laptop, 'host')).toMatchObject({ ok: true });
    releaseProfile();
    expect(codeOf(await joining)).toBe('quizshow_organiser_running');
    expect(harness.state.players.size).toBe(0);

    // A host attach whose checks passed before a lobby:join landed is refused.
    const otherHarness = createHarness();
    try {
      const otherPhone = await connect(
        otherHarness,
        'socket-phone',
        COHOST_USER_ID,
      );
      await attach(otherHarness, otherPhone, 'player');
      const otherLaptop = await connect(
        otherHarness,
        'socket-laptop',
        COHOST_USER_ID,
      );
      const realExecute = otherHarness.runtime.execute.bind(
        otherHarness.runtime,
      );
      const joinAcks: Array<QuizshowAck<{ me: QuizshowMe }>> = [];
      jest.spyOn(otherHarness.runtime, 'execute').mockImplementationOnce(((
        sessionId: string,
        command: never,
        options: never,
      ) =>
        joinLobby(otherHarness, otherPhone).then((joinAck) => {
          joinAcks.push(joinAck);
          return realExecute(sessionId, command, options);
        })) as unknown as QuizshowRuntimeService['execute']);

      expect(codeOf(await attach(otherHarness, otherLaptop, 'host'))).toBe(
        'quizshow_cohost_is_playing',
      );
      expect(joinAcks).toEqual([
        expect.objectContaining({
          ok: true,
          me: expect.objectContaining({ isCohostPlayer: true }) as unknown,
        }),
      ]);
      expect(
        otherHarness.state.attachedOrganiserUserIds.has(COHOST_USER_ID),
      ).toBe(false);
    } finally {
      otherHarness.runtime.onModuleDestroy();
    }
  });

  it('drops the sockets of a signed-out device and of a revoked member', async () => {
    const phone = await connect(harness, 'socket-phone', PLAYER_USER_ID);
    harness.jwt.verifyAsync.mockImplementationOnce((token: string) =>
      Promise.resolve({
        sub: token,
        status: UserStatus.Active,
        exp: Math.floor(Date.now() / 1000) + 900,
        sid: 'family-tablet',
      }),
    );
    const tablet = await connect(harness, 'socket-tablet', PLAYER_USER_ID);
    const hostRemote = await connect(harness, 'socket-host', HOST_USER_ID);

    harness.gateway.handleSessionRevoked({
      userId: PLAYER_USER_ID,
      sessionId: `family-${PLAYER_USER_ID}`,
    });
    expect(phone.emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({ code: 'SESSION_REVOKED' }),
    );
    expect(phone.disconnect).toHaveBeenCalledWith(true);
    expect(tablet.disconnect).not.toHaveBeenCalled();

    harness.gateway.handleSessionRevoked({ userId: PLAYER_USER_ID });
    expect(tablet.disconnect).toHaveBeenCalledWith(true);
    expect(clientEmits(tablet, 'exception')).toHaveLength(0);
    expect(hostRemote.disconnect).not.toHaveBeenCalled();
  });

  it('re-checks the organiser on every host command', async () => {
    const cohostRemote = await attachedHost(
      harness,
      'socket-cohost',
      COHOST_USER_ID,
    );
    expect(await setScreenMuted(harness, cohostRemote, true)).toEqual({
      ok: true,
      isNoop: false,
    });

    harness.organiserUserIds.delete(COHOST_USER_ID);
    expect(codeOf(await setScreenMuted(harness, cohostRemote, false))).toBe(
      'quizshow_not_organiser',
    );
    expect(codeOf(await hostNext(harness, cohostRemote, '0'))).toBe(
      'quizshow_not_organiser',
    );
    expect(harness.state.isScreenMuted).toBe(true);
    const commandChecks = harness.eventsService.isOrganizer.mock.calls.filter(
      (call: unknown[]) => call[1] === COHOST_USER_ID,
    );
    expect(commandChecks).toHaveLength(3);
  });

  it('serialises host commands of one session', async () => {
    await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
    const hostRemote = await attachedHost(harness, 'socket-host');
    const laptopRemote = await attachedHost(harness, 'socket-laptop');
    expect(
      await harness.gateway.handleHostStart(asClient(hostRemote), {
        phaseId: '0',
      }),
    ).toEqual({ ok: true, isNoop: false });
    const introPhaseId = harness.state.cursor.phaseId;
    expect(harness.state.cursor.phase).toBe('round_intro');

    const acks = await Promise.all([
      hostNext(harness, hostRemote, introPhaseId),
      hostNext(harness, laptopRemote, introPhaseId),
    ]);

    expect(acks).toEqual(
      expect.arrayContaining([
        { ok: true, isNoop: false },
        { ok: true, isNoop: true },
      ]),
    );
    expect(harness.state.cursor.phase).toBe('read');
    expect(harness.state.lastTransition?.fromPhaseId).toBe(introPhaseId);
  });

  it('rate limits the sixth answer in a burst', async () => {
    const { client } = await joinedPlayer(
      harness,
      'socket-player',
      PLAYER_USER_ID,
    );
    const codes: Array<string | null> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      codes.push(codeOf(await submitAnswer(harness, client)));
    }
    expect(codes.slice(0, 5)).not.toContain('quizshow_rate_limited');
    expect(codes[5]).toBe('quizshow_rate_limited');
  });

  it('answers time ping with pong and drops pings past the bucket', async () => {
    const screen = await connect(harness, 'socket-screen', HOST_USER_ID);
    await attach(harness, screen, 'screen');
    const results: unknown[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      results.push(
        await harness.gateway.handleTimePing(asClient(screen), {
          clientSentAt: 1000 + attempt,
        }),
      );
    }
    expect(results.every((result) => result === undefined)).toBe(true);
    const pongs = clientEmits(screen, 'time:pong') as Array<{
      clientSentAt: number;
      serverReceivedAt: number;
      serverSentAt: number;
    }>;
    expect(pongs).toHaveLength(10);
    const firstPong = pongs[0];
    expect(firstPong?.clientSentAt).toBe(1000);
    expect(typeof firstPong?.serverReceivedAt).toBe('number');
    expect(firstPong?.serverSentAt).toBeGreaterThanOrEqual(
      firstPong?.serverReceivedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it('mutes the screen for every screen and host socket and acks a repeat as a noop', async () => {
    const screen = await connect(harness, 'socket-screen', HOST_USER_ID);
    await attach(harness, screen, 'screen');
    await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
    const hostRemote = await attachedHost(harness, 'socket-host');

    expect(await setScreenMuted(harness, hostRemote, true)).toEqual({
      ok: true,
      isNoop: false,
    });
    const mutedFrames = () => roomEmitsOf(harness, 'screen:muted');
    expect(mutedFrames()).toEqual([
      {
        room: quizshowRoomName(SESSION_ID, 'screen'),
        event: 'screen:muted',
        payload: { isMuted: true },
      },
      {
        room: quizshowRoomName(SESSION_ID, 'hosts'),
        event: 'screen:muted',
        payload: { isMuted: true },
      },
    ]);
    expect(
      mutedFrames().some(
        (record) => record.room === quizshowRoomName(SESSION_ID, 'players'),
      ),
    ).toBe(false);

    expect(await setScreenMuted(harness, hostRemote, true)).toEqual({
      ok: true,
      isNoop: true,
    });
    expect(mutedFrames()).toHaveLength(2);
    expect(harness.state.isScreenMuted).toBe(true);
  });

  it('never writes a screen name or answer text to a log line', async () => {
    const logSpies = (
      ['debug', 'log', 'warn', 'error', 'verbose'] as const
    ).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
    );
    const blockedScreenName = `Hi ${BLOCKED_WORD}`;
    const acceptedScreenName = 'Sparkly Robin';
    const blockedAnswerText = `So ${BLOCKED_WORD}`;
    const answerText = 'Secret answer text';

    const hostRemote = await attachedHost(harness, 'socket-host');
    const client = await connect(harness, 'socket-player', PLAYER_USER_ID);
    await attach(harness, client, 'player');
    expect(codeOf(await joinLobby(harness, client, blockedScreenName))).toBe(
      'quizshow_text_blocked',
    );
    expect((await joinLobby(harness, client, acceptedScreenName)).ok).toBe(
      true,
    );
    expect(
      codeOf(
        await submitAnswer(harness, client, {
          type: 'type_answer',
          text: answerText,
        }),
      ),
    ).toBe('quizshow_phase_closed');

    // Into the open phase of the typed question, where the engine reads the text.
    await harness.gateway.handleHostStart(asClient(hostRemote), {
      phaseId: '0',
    });
    await hostNext(harness, hostRemote, harness.state.cursor.phaseId);
    await hostNext(harness, hostRemote, harness.state.cursor.phaseId);
    expect(harness.state.cursor.phase).toBe('open');
    const openPhaseId = harness.state.cursor.phaseId;
    expect(
      codeOf(
        await submitAnswer(
          harness,
          client,
          { type: 'type_answer', text: blockedAnswerText },
          openPhaseId,
        ),
      ),
    ).toBe('quizshow_text_blocked');
    expect(
      (
        await submitAnswer(
          harness,
          client,
          { type: 'type_answer', text: answerText },
          openPhaseId,
        )
      ).ok,
    ).toBe(true);

    const loggedTexts = logSpies.flatMap((spy) =>
      spy.mock.calls.flat().map((argument) => String(argument)),
    );
    expect(
      loggedTexts.some((text) =>
        text.includes('lobby:join refused: quizshow_text_blocked'),
      ),
    ).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes('answer:submit refused: quizshow_text_blocked'),
      ),
    ).toBe(true);
    expect(
      loggedTexts.some((text) => text.includes('quizshow_phase_closed')),
    ).toBe(true);
    for (const secret of [
      BLOCKED_WORD,
      blockedScreenName,
      acceptedScreenName,
      blockedAnswerText,
      answerText,
    ]) {
      expect(loggedTexts.some((text) => text.includes(secret))).toBe(false);
    }
  });
});
