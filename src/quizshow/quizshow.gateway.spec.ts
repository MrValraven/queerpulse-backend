import { Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Namespace } from 'socket.io';
import type { Repository } from 'typeorm';
import type { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import { ChatWsException } from '../chat/ws-error';
import { BLOCKED_TERMS } from '../common/blocked-terms';
import type { FeatureAccessService } from '../early-access/feature-access.service';
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
import type { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import type { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowAccessService } from './quizshow-access.service';
import { QuizshowDevicePairingService } from './quizshow-device-pairing.service';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowAck,
  type QuizshowAttachRole,
  type QuizshowMe,
} from './quizshow.contract';
import * as quizshowPhases from './quizshow-engine-phases';
import * as quizshowPlayers from './quizshow-engine-players';
import * as quizshowRescore from './quizshow-engine-rescore';
import * as quizshowRoster from './quizshow-engine-roster';
import * as quizshowSessionTools from './quizshow-engine-session-tools';
import { createLobbyState, refuse } from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowLiveState,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import * as quizshowFrames from './quizshow-frames';
import { quizshowPlayerRoomName, quizshowRoomName } from './quizshow-frames';
import { QuizshowGateway } from './quizshow.gateway';
import type { QuizshowPersistenceService } from './quizshow-persistence.service';
import type { QuizshowSessionsService } from './quizshow-sessions.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import type {
  QuizshowRandom,
  QuizshowSnapshotQuestion,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const QUESTION_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = 'event-1';
const HOST_USER_ID = 'host-user';
const COHOST_USER_ID = 'cohost-user';
const PLAYER_USER_ID = 'player-user';
const OUTSIDER_USER_ID = 'outsider-user';
const STRANGER_USER_ID = 'stranger-user';
const GAME_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_USER_ID = 'owner-user';
const BLOCKED_WORD = BLOCKED_TERMS[0] ?? 'blocked';
const START = Date.UTC(2026, 9, 19, 20, 0, 0);
const OPEN_STATUSES = new Set(['lobby', 'running', 'paused']);

type GatewayClient = Parameters<QuizshowGateway['handleConnection']>[0];

interface FakeClient {
  id: string;
  connected: boolean;
  handshake: {
    auth: { token?: string; deviceTicket?: string };
    headers: Record<string, string | undefined>;
  };
  data: Record<string, unknown>;
  emit: jest.Mock;
  join: jest.Mock;
  leave: jest.Mock;
  disconnect: jest.Mock;
  /** The rooms `join` and `leave` kept, as `socket.rooms`. */
  rooms: Set<string>;
  /** `client.timeout(ms)`: returns an emitter that records each `time:probe`. */
  timeout: jest.Mock;
  probes: FakeProbe[];
}

/** One `time:probe` the gateway sent; `acknowledge` plays the client's ack or the timeout. */
interface FakeProbe {
  timeoutMs: number;
  event: string;
  payload: { sentAt: number };
  acknowledge: (error: Error | null) => void;
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
  /** The events repository the access service reads. */
  events: { findOne: jest.Mock };
  blockFilter: { isBlockedEitherWay: jest.Mock };
  profiles: { findOne: jest.Mock };
  refreshTokens: { exists: jest.Mock };
  jwt: { verifyAsync: jest.Mock };
  /** Members without a Pulse Live grant; everyone else holds one. */
  ungrantedUserIds: Set<string>;
  featureAccess: { canUseFeature: jest.Mock };
  sessionsService: { notifyGuestsForSession: jest.Mock };
  /** The real pairing service, so tickets are minted and verified as in production. */
  pairingService: QuizshowDevicePairingService;
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

/** The empty text the v2 question fields hold when a question has none. */
const NO_TEXT = { en: '', pt: '' };

function trueFalseQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'true_false',
    prompt: { en: 'Is it true?', pt: 'É verdade?' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: NO_TEXT,
    mediaReveal: 'instant',
    revealNote: NO_TEXT,
    numberUnit: NO_TEXT,
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
    mediaAlt: NO_TEXT,
    mediaReveal: 'instant',
    revealNote: NO_TEXT,
    numberUnit: NO_TEXT,
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: { text: { en: 'Stonewall Inn', pt: 'Stonewall Inn' } },
    acceptedAnswers: ['Stonewall'],
    shownOptions: null,
  };
}

interface HarnessOptions {
  /** `'game'` builds a session of a game owned by OWNER_USER_ID with no event. */
  kind?: 'event' | 'game';
  isAdultsOnly?: boolean;
  /** Plays [wheel, quiz of one question, quiz of one question] instead of the single two-question quiz. */
  hasWheelFirst?: boolean;
}

const ROUND_SETTINGS = {
  timeLimitSeconds: 20,
  isSpeedBonusOn: true,
  isJokerAllowed: true,
  writeSeconds: 60,
  voteSeconds: 30,
  isWarmUp: false,
  talkSeconds: 0 as const,
  ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
};

function singleQuestionRound(
  roundId: string,
  questionId: string,
): QuizshowSnapshotRound {
  return {
    id: roundId,
    kind: 'quiz',
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: ROUND_SETTINGS,
    questions: [trueFalseQuestion(questionId)],
  };
}

/** A wheel row first, then two quiz rounds of one question each. */
function wheelFirstRounds(): QuizshowSnapshotRound[] {
  return [
    {
      id: 'wheel-1',
      kind: 'wheel',
      title: { en: 'Wheel', pt: 'Roda' },
      contentLabel: 'none',
      settings: ROUND_SETTINGS,
      questions: [],
    },
    singleQuestionRound('round-2', '55555555-5555-4555-8555-555555555555'),
    singleQuestionRound('round-3', '66666666-6666-4666-8666-666666666666'),
  ];
}

function lobbyState(options: HarnessOptions = {}): QuizshowLiveState {
  const isGame = options.kind === 'game';
  const scopeFields = isGame
    ? {
        eventId: null,
        eventSlug: null,
        eventTitle: null,
        kind: 'game' as const,
        gameId: GAME_ID,
        hostUserId: OWNER_USER_ID,
        openedByUserId: OWNER_USER_ID,
      }
    : {
        eventId: EVENT_ID,
        eventSlug: 'pride-night',
        eventTitle: 'Pride night',
        kind: 'event' as const,
        gameId: null,
        hostUserId: HOST_USER_ID,
        openedByUserId: HOST_USER_ID,
      };
  return createLobbyState({
    sessionId: SESSION_ID,
    ...scopeFields,
    isAdultsOnly: options.isAdultsOnly ?? false,
    joinCode: 'ABC234',
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: false,
    isPractice: false,
    snapshot: {
      title: 'Pride night quiz',
      languages: 'both',
      screenLanguage: 'en',
      sourceUpdatedAt: '2026-10-19T19:00:00.000Z',
      rounds: options.hasWheelFirst
        ? wheelFirstRounds()
        : [
            {
              id: 'round-1',
              kind: 'quiz',
              title: { en: 'Round', pt: 'Ronda' },
              contentLabel: 'none',
              settings: ROUND_SETTINGS,
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

function createHarness(options: HarnessOptions = {}): Harness {
  const state = lobbyState(options);
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
  const ungrantedUserIds = new Set<string>();
  const featureAccess = {
    canUseFeature: jest.fn((_featureKey: string, userId: string | null) =>
      Promise.resolve(userId !== null && !ungrantedUserIds.has(userId)),
    ),
  };
  const blockFilter = {
    isBlockedEitherWay: jest.fn(() => Promise.resolve(false)),
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
    blockFilter as unknown as BlockFilterService,
    {
      findOne: jest.fn(() => Promise.resolve(null)),
    } as unknown as Repository<QuizshowQuizRecord>,
    {
      findOne: jest.fn(() => Promise.resolve(null)),
    } as unknown as Repository<Profile>,
  );
  const sessionsService = {
    notifyGuestsForSession: jest.fn(
      (_sessionId: string): Promise<string | null> => Promise.resolve(null),
    ),
  };
  const pairingService = new QuizshowDevicePairingService(new JwtService({}), {
    getOrThrow: () => 'secret',
  } as unknown as ConfigService);
  const gateway = new QuizshowGateway(
    jwt as unknown as JwtService,
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
    runtime,
    access,
    eventsService as unknown as EventsService,
    users as unknown as Repository<User>,
    profiles as unknown as Repository<Profile>,
    refreshTokens as unknown as Repository<RefreshToken>,
    sessionRows as unknown as Repository<QuizshowSessionRecord>,
    platformSettings as unknown as PlatformSettingsService,
    featureAccess as unknown as FeatureAccessService,
    sessionsService as unknown as QuizshowSessionsService,
    pairingService,
    blockFilter as unknown as BlockFilterService,
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
    events,
    blockFilter,
    profiles,
    refreshTokens,
    jwt,
    ungrantedUserIds,
    featureAccess,
    sessionsService,
    pairingService,
  };
}

function makeClient(socketId: string, userId: string): FakeClient {
  const client: FakeClient = {
    id: socketId,
    connected: true,
    handshake: { auth: { token: userId }, headers: {} },
    data: {},
    emit: jest.fn(),
    join: jest.fn((room: string) => {
      client.rooms.add(room);
      return Promise.resolve();
    }),
    leave: jest.fn((room: string) => {
      client.rooms.delete(room);
      return Promise.resolve();
    }),
    rooms: new Set<string>(),
    disconnect: jest.fn(() => {
      client.connected = false;
    }),
    timeout: jest.fn((timeoutMs: number) => ({
      emit: (
        event: string,
        payload: { sentAt: number },
        acknowledge: (error: Error | null) => void,
      ) => {
        client.probes.push({ timeoutMs, event, payload, acknowledge });
        return true;
      },
    })),
    probes: [],
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

/** `hasAcceptedAdultContent` is sent only when given, so a call without it omits the field. */
function joinLobby(
  harness: Harness,
  client: FakeClient,
  screenName = 'Robin',
  hasAcceptedAdultContent?: boolean,
): Promise<QuizshowAck<{ me: QuizshowMe }>> {
  return harness.gateway.handleLobbyJoin(asClient(client), {
    screenName,
    isAvatarShown: false,
    hasExtraTime: false,
    team: null,
    ...(hasAcceptedAdultContent === undefined
      ? {}
      : { hasAcceptedAdultContent }),
  });
}

/**
 * Marks a connected socket as attached in the given role without the attach
 * checks, standing for a socket whose attach the gateway would refuse, so
 * the frame's own check is the one that answers.
 */
function forgeAttachedSocket(
  client: FakeClient,
  role: QuizshowAttachRole,
): void {
  client.data.sessionId = SESSION_ID;
  client.data.role = role;
  client.data.playerId = null;
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

function hostSpin(harness: Harness, client: FakeClient, phaseId: string) {
  return harness.gateway.handleHostSpin(asClient(client), { phaseId });
}

function finishWheel(harness: Harness, client: FakeClient, phaseId: string) {
  return harness.gateway.handleHostFinishWheel(asClient(client), { phaseId });
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

  /** Swaps the event lobby of `beforeEach` for a session built from `options`. */
  function replaceHarness(options: HarnessOptions): void {
    harness.runtime.onModuleDestroy();
    harness.gateway.onModuleDestroy();
    harness = createHarness(options);
  }

  it('refuses the handshake while Pulse Live is neither launched nor in early access', async () => {
    jest.spyOn(launchedFeatures, 'isFeatureLaunched').mockReturnValue(false);
    jest.spyOn(launchedFeatures, 'isEarlyAccessFeature').mockReturnValue(false);
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
    expect(harness.featureAccess.canUseFeature).not.toHaveBeenCalled();
    await expect(attach(harness, memberClient, 'player')).rejects.toThrow(
      ChatWsException,
    );
  });

  describe('while Pulse Live is in early access', () => {
    beforeEach(() => {
      jest.spyOn(launchedFeatures, 'isFeatureLaunched').mockReturnValue(false);
      jest
        .spyOn(launchedFeatures, 'isEarlyAccessFeature')
        .mockReturnValue(true);
    });

    it('admits a member without the grant to the handshake and the player attach', async () => {
      harness.ungrantedUserIds.add(PLAYER_USER_ID);
      const client = await connect(harness, 'socket-1', PLAYER_USER_ID);

      expect(harness.jwt.verifyAsync).toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(clientEmits(client, 'exception')).toHaveLength(0);
      expect(client.data.userId).toBe(PLAYER_USER_ID);

      expect(await attach(harness, client, 'player')).toMatchObject({
        ok: true,
        role: 'player',
      });
      const joinAck = await joinLobby(harness, client);
      expect(joinAck.ok).toBe(true);
      expect(client.data.role).toBe('player');
      // Grants are never read for playing.
      expect(harness.featureAccess.canUseFeature).not.toHaveBeenCalled();
    });

    it('refuses a host attach and a host command from a member without the grant', async () => {
      harness.ungrantedUserIds.add(COHOST_USER_ID);
      const cohostLaptop = await connect(
        harness,
        'socket-cohost',
        COHOST_USER_ID,
      );
      expect(codeOf(await attach(harness, cohostLaptop, 'host'))).toBe(
        'quizshow_session_not_found',
      );
      expect(codeOf(await attach(harness, cohostLaptop, 'screen'))).toBe(
        'quizshow_session_not_found',
      );
      expect(cohostLaptop.data.role).toBeUndefined();
      expect(cohostLaptop.join).not.toHaveBeenCalled();
      expect(harness.state.attachedOrganiserUserIds.has(COHOST_USER_ID)).toBe(
        false,
      );

      await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
      const hostRemote = await attachedHost(harness, 'socket-host');
      harness.ungrantedUserIds.add(HOST_USER_ID);
      expect(codeOf(await setScreenMuted(harness, hostRemote, true))).toBe(
        'quizshow_session_not_found',
      );
      expect(
        codeOf(
          await harness.gateway.handleHostStart(asClient(hostRemote), {
            phaseId: '0',
          }),
        ),
      ).toBe('quizshow_session_not_found');
      expect(harness.state.isScreenMuted).toBe(false);
      expect(harness.state.cursor.phase).toBe('lobby');
    });

    it('admits grant holders as host, big screen and player', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      expect(hostRemote.disconnect).not.toHaveBeenCalled();

      const screen = await connect(harness, 'socket-screen', COHOST_USER_ID);
      expect(await attach(harness, screen, 'screen')).toMatchObject({
        ok: true,
        role: 'screen',
      });

      const { client: player } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      expect(player.data.userId).toBe(PLAYER_USER_ID);
      expect(player.disconnect).not.toHaveBeenCalled();
    });

    it('refuses session:reauth for a host socket whose grant is gone and keeps a player socket', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      harness.ungrantedUserIds.add(PLAYER_USER_ID);
      const { client: player } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );

      harness.ungrantedUserIds.add(HOST_USER_ID);
      const hostTicket = socketTicketService.mint(
        HOST_USER_ID,
        `family-${HOST_USER_ID}`,
        UserStatus.Active,
        15 * 60_000,
      );
      const refused = await harness.gateway.handleReauth(asClient(hostRemote), {
        ticket: hostTicket.ticket,
      });
      expect(refused).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(hostRemote.emit).toHaveBeenCalledWith(
        'exception',
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
      );
      expect(hostRemote.disconnect).toHaveBeenCalledWith(true);

      const playerTicket = socketTicketService.mint(
        PLAYER_USER_ID,
        `family-${PLAYER_USER_ID}`,
        UserStatus.Active,
        15 * 60_000,
      );
      const extended = await harness.gateway.handleReauth(asClient(player), {
        ticket: playerTicket.ticket,
      });
      expect(extended).toMatchObject({ ok: true });
      expect(player.disconnect).not.toHaveBeenCalled();
      expect(
        harness.featureAccess.canUseFeature.mock.calls.some(
          (call: unknown[]) => call[1] === PLAYER_USER_ID,
        ),
      ).toBe(false);
    });
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
    // The handshake never reads a grant: hosting checks it at attach.
    expect(harness.featureAccess.canUseFeature).not.toHaveBeenCalled();
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

  it('refuses host:spin and host:finishWheel from a player socket', async () => {
    const { client: player } = await joinedPlayer(
      harness,
      'socket-player',
      PLAYER_USER_ID,
    );
    expect(codeOf(await hostSpin(harness, player, '0'))).toBe(
      'quizshow_wrong_role',
    );
    expect(codeOf(await finishWheel(harness, player, '0'))).toBe(
      'quizshow_wrong_role',
    );
    expect(harness.state.cursor.phase).toBe('lobby');
  });

  it('answers a spin outside the wheel with the reason and the cursor', async () => {
    const hostRemote = await attachedHost(harness, 'socket-host');
    const ack = await hostSpin(
      harness,
      hostRemote,
      harness.state.cursor.phaseId,
    );
    expect(ack).toMatchObject({
      ok: false,
      code: 'quizshow_session_not_started',
      cursor: { phase: 'lobby', upNext: expect.anything() as unknown },
    });
    expect(harness.state.cursor.phase).toBe('lobby');
  });

  describe('a session that opens on a wheel', () => {
    beforeEach(() => {
      harness = createHarness({ hasWheelFirst: true });
    });

    async function startedWheel(): Promise<FakeClient> {
      // host:start refuses an empty lobby with quizshow_no_players.
      await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
      const hostRemote = await attachedHost(harness, 'socket-host');
      expect(
        await harness.gateway.handleHostStart(asClient(hostRemote), {
          phaseId: '0',
        }),
      ).toEqual({ ok: true, isNoop: false });
      expect(harness.state.cursor.phase).toBe('wheel');
      return hostRemote;
    }

    it('spins the wheel for the host', async () => {
      const hostRemote = await startedWheel();
      const ack = await hostSpin(
        harness,
        hostRemote,
        harness.state.cursor.phaseId,
      );
      expect(ack).toEqual({ ok: true, isNoop: false });
      expect(harness.state.wheelProgress.wheel?.spin).not.toBeNull();
      expect(harness.state.cursor.phase).toBe('wheel');
    });

    it('finishes the wheel for the host', async () => {
      const hostRemote = await startedWheel();
      const ack = await finishWheel(
        harness,
        hostRemote,
        harness.state.cursor.phaseId,
      );
      expect(ack).toEqual({ ok: true, isNoop: false });
      expect(harness.state.cursor.phase).toBe('podium');
    });
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

  describe('a game session', () => {
    beforeEach(() => {
      replaceHarness({ kind: 'game' });
    });

    it('attaches the owner of a game as host and screen and refuses another member with session not found', async () => {
      const ownerRemote = await attachedHost(
        harness,
        'socket-owner-remote',
        OWNER_USER_ID,
      );
      expect(ownerRemote.data.role).toBe('host');
      const ownerScreen = await connect(
        harness,
        'socket-owner-screen',
        OWNER_USER_ID,
      );
      expect(await attach(harness, ownerScreen, 'screen')).toMatchObject({
        ok: true,
        role: 'screen',
      });

      // An event organiser and any other member hold no role in a game.
      const otherMembers = [
        ['socket-event-host', HOST_USER_ID],
        ['socket-outsider', OUTSIDER_USER_ID],
      ] as const;
      for (const [socketId, userId] of otherMembers) {
        const client = await connect(harness, socketId, userId);
        expect(codeOf(await attach(harness, client, 'host'))).toBe(
          'quizshow_session_not_found',
        );
        expect(codeOf(await attach(harness, client, 'screen'))).toBe(
          'quizshow_session_not_found',
        );
        expect(client.data.role).toBeUndefined();
        expect(client.join).not.toHaveBeenCalled();
      }
      expect([...harness.state.attachedOrganiserUserIds]).toEqual([
        OWNER_USER_ID,
      ]);
      expect(harness.eventsService.assertCanView).not.toHaveBeenCalled();
    });

    it('runs host commands of a game for the owner only', async () => {
      await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
      const ownerRemote = await attachedHost(
        harness,
        'socket-owner',
        OWNER_USER_ID,
      );
      expect(
        await harness.gateway.handleHostStart(asClient(ownerRemote), {
          phaseId: '0',
        }),
      ).toEqual({ ok: true, isNoop: false });
      expect(harness.state.cursor.phase).toBe('round_intro');
      const introPhaseId = harness.state.cursor.phaseId;

      // An event organiser on a host socket the attach would have refused.
      const otherRemote = await connect(harness, 'socket-other', HOST_USER_ID);
      forgeAttachedSocket(otherRemote, 'host');
      expect(codeOf(await hostNext(harness, otherRemote, introPhaseId))).toBe(
        'quizshow_not_organiser',
      );
      expect(codeOf(await setScreenMuted(harness, otherRemote, true))).toBe(
        'quizshow_not_organiser',
      );
      expect(harness.state.cursor.phaseId).toBe(introPhaseId);
      expect(harness.state.isScreenMuted).toBe(false);
      expect(harness.eventsService.isOrganizer).not.toHaveBeenCalled();

      expect(await hostNext(harness, ownerRemote, introPhaseId)).toEqual({
        ok: true,
        isNoop: false,
      });
      expect(harness.state.cursor.phase).toBe('read');
    });

    it('refuses lobby:join from the game owner', async () => {
      const ownerPhone = await connect(
        harness,
        'socket-owner-phone',
        OWNER_USER_ID,
      );
      expect(codeOf(await attach(harness, ownerPhone, 'player'))).toBe(
        'quizshow_organiser_running',
      );
      expect(ownerPhone.data.role).toBeUndefined();

      // A player socket the attach would have refused: the join checks again.
      forgeAttachedSocket(ownerPhone, 'player');
      expect(codeOf(await joinLobby(harness, ownerPhone))).toBe(
        'quizshow_organiser_running',
      );
      expect(harness.state.players.size).toBe(0);
      expect(ownerPhone.data.playerId).toBeNull();
    });

    it('refuses lobby:join between a player and an owner who blocked each other with banned from event', async () => {
      const phone = await connect(harness, 'socket-phone', PLAYER_USER_ID);
      expect(await attach(harness, phone, 'player')).toMatchObject({
        ok: true,
      });

      // The block lands while the player waits in the lobby.
      harness.blockFilter.isBlockedEitherWay.mockImplementation(
        (ownerUserId: string, userId: string) =>
          Promise.resolve(
            ownerUserId === OWNER_USER_ID && userId === PLAYER_USER_ID,
          ),
      );
      expect(codeOf(await joinLobby(harness, phone))).toBe(
        'quizshow_banned_from_event',
      );
      expect(harness.state.players.size).toBe(0);
      expect(harness.blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        OWNER_USER_ID,
        PLAYER_USER_ID,
      );

      const tablet = await connect(harness, 'socket-tablet', PLAYER_USER_ID);
      expect(codeOf(await attach(harness, tablet, 'player'))).toBe(
        'quizshow_banned_from_event',
      );

      // A member with no block plays on.
      await joinedPlayer(harness, 'socket-outsider', OUTSIDER_USER_ID);
      expect(harness.state.players.size).toBe(1);
    });

    it('never calls the events repository for a game session with no event', async () => {
      expect(harness.state.eventId).toBeNull();
      const ownerRemote = await attachedHost(
        harness,
        'socket-owner',
        OWNER_USER_ID,
      );
      const ownerScreen = await connect(
        harness,
        'socket-owner-screen',
        OWNER_USER_ID,
      );
      await attach(harness, ownerScreen, 'screen');
      await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
      expect(await setScreenMuted(harness, ownerRemote, true)).toEqual({
        ok: true,
        isNoop: false,
      });
      const stranger = await connect(
        harness,
        'socket-stranger',
        STRANGER_USER_ID,
      );
      expect(codeOf(await attach(harness, stranger, 'host'))).toBe(
        'quizshow_session_not_found',
      );

      expect(harness.events.findOne).not.toHaveBeenCalled();
      expect(harness.eventsService.isOrganizer).not.toHaveBeenCalled();
      expect(harness.eventsService.assertCanView).not.toHaveBeenCalled();
    });
  });

  describe('an 18+ session', () => {
    it('refuses a first lobby:join to an 18+ session without consent and accepts it with consent', async () => {
      replaceHarness({ kind: 'game', isAdultsOnly: true });
      const phone = await connect(harness, 'socket-phone', PLAYER_USER_ID);
      expect(await attach(harness, phone, 'player')).toMatchObject({
        ok: true,
      });

      expect(codeOf(await joinLobby(harness, phone))).toBe(
        'quizshow_adult_consent_required',
      );
      expect(codeOf(await joinLobby(harness, phone, 'Robin', false))).toBe(
        'quizshow_adult_consent_required',
      );
      expect(harness.state.players.size).toBe(0);
      expect(phone.data.playerId).toBeNull();

      const accepted = await joinLobby(harness, phone, 'Robin', true);
      expect(accepted.ok).toBe(true);
      expect(harness.state.players.size).toBe(1);
    });

    it('lets a joined player rejoin an 18+ session without the consent field', async () => {
      replaceHarness({ kind: 'game', isAdultsOnly: true });
      const phone = await connect(harness, 'socket-phone', PLAYER_USER_ID);
      await attach(harness, phone, 'player');
      const firstJoin = await joinLobby(harness, phone, 'Robin', true);
      if (!firstJoin.ok) {
        throw new Error(`lobby:join refused with ${firstJoin.code}`);
      }
      const { playerId } = firstJoin.me;

      expect(await joinLobby(harness, phone)).toMatchObject({
        ok: true,
        me: { playerId },
      });

      const laptop = await connect(harness, 'socket-laptop', PLAYER_USER_ID);
      expect(await attach(harness, laptop, 'player')).toMatchObject({
        ok: true,
      });
      expect(await joinLobby(harness, laptop)).toMatchObject({
        ok: true,
        me: { playerId },
      });
      expect(harness.state.players.size).toBe(1);
    });

    it('asks consent for an 18+ event game', async () => {
      replaceHarness({ kind: 'event', isAdultsOnly: true });
      const phone = await connect(harness, 'socket-phone', PLAYER_USER_ID);
      expect(await attach(harness, phone, 'player')).toMatchObject({
        ok: true,
      });

      expect(codeOf(await joinLobby(harness, phone))).toBe(
        'quizshow_adult_consent_required',
      );
      expect(harness.state.players.size).toBe(0);

      const accepted = await joinLobby(harness, phone, 'Robin', true);
      expect(accepted.ok).toBe(true);
      expect(harness.state.players.size).toBe(1);
    });
  });

  describe('host commands of the live v2 build', () => {
    const PHASE_ID = '7';
    const TARGET_PLAYER_ID = '77777777-7777-4777-8777-777777777777';
    const TEAM_ID = '88888888-8888-4888-8888-888888888888';
    const REQUEST_ID = '99999999-9999-4999-8999-999999999999';

    function hostSuccess(): QuizshowCommandOutcome<{ isNoop: boolean }> {
      return { ok: true, success: { isNoop: false }, effects: [] };
    }

    function hostRefusal(
      code: Parameters<typeof refuse>[0],
    ): QuizshowCommandOutcome<{ isNoop: boolean }> {
      return refuse<{ isNoop: boolean }>(code, harness.state, true);
    }

    it('runs host:acceptAnswer through hostAcceptAnswer and passes its refusal through', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const command = jest
        .spyOn(quizshowRescore, 'hostAcceptAnswer')
        .mockReturnValueOnce(hostSuccess())
        .mockReturnValueOnce(hostRefusal('quizshow_rescore_not_now'));
      const payload = {
        phaseId: PHASE_ID,
        questionId: QUESTION_ID,
        normalisedText: 'stonewall',
      };

      expect(
        await harness.gateway.handleHostAcceptAnswer(
          asClient(hostRemote),
          payload,
        ),
      ).toEqual({ ok: true, isNoop: false });
      expect(command).toHaveBeenCalledWith(
        harness.state,
        payload,
        expect.any(Number),
      );
      expect(
        await harness.gateway.handleHostAcceptAnswer(
          asClient(hostRemote),
          payload,
        ),
      ).toMatchObject({
        ok: false,
        code: 'quizshow_rescore_not_now',
        cursor: { phaseId: harness.state.cursor.phaseId },
      });
    });

    it('runs host:changeCorrectAnswer with the new key of its type and passes its refusal through', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const command = jest
        .spyOn(quizshowRescore, 'hostChangeCorrectAnswer')
        .mockReturnValueOnce(hostSuccess())
        .mockReturnValueOnce(hostRefusal('quizshow_every_option_correct'));

      expect(
        await harness.gateway.handleHostChangeCorrectAnswer(
          asClient(hostRemote),
          {
            phaseId: PHASE_ID,
            questionId: QUESTION_ID,
            answer: { type: 'multiple_choice', correctIndexes: [0, 2] },
          },
        ),
      ).toEqual({ ok: true, isNoop: false });
      expect(command).toHaveBeenCalledWith(
        harness.state,
        {
          phaseId: PHASE_ID,
          questionId: QUESTION_ID,
          answer: { type: 'multiple_choice', correctIndexes: [0, 2] },
        },
        expect.any(Number),
      );
      expect(
        codeOf(
          await harness.gateway.handleHostChangeCorrectAnswer(
            asClient(hostRemote),
            {
              phaseId: PHASE_ID,
              questionId: QUESTION_ID,
              answer: { type: 'true_false', isTrue: false },
            },
          ),
        ),
      ).toBe('quizshow_every_option_correct');
      expect(command).toHaveBeenLastCalledWith(
        harness.state,
        {
          phaseId: PHASE_ID,
          questionId: QUESTION_ID,
          answer: { type: 'true_false', isTrue: false },
        },
        expect.any(Number),
      );
    });

    it('runs host:adjustPoints through hostAdjustPoints and passes its refusal through', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const command = jest
        .spyOn(quizshowRescore, 'hostAdjustPoints')
        .mockReturnValueOnce(hostSuccess())
        .mockReturnValueOnce(hostRefusal('quizshow_adjust_below_zero'));
      const payload = {
        entrantId: TARGET_PLAYER_ID,
        delta: -50,
        requestId: REQUEST_ID,
      };

      expect(
        await harness.gateway.handleHostAdjustPoints(
          asClient(hostRemote),
          payload,
        ),
      ).toEqual({ ok: true, isNoop: false });
      expect(command).toHaveBeenCalledWith(
        harness.state,
        payload,
        expect.any(Number),
      );
      expect(
        codeOf(
          await harness.gateway.handleHostAdjustPoints(
            asClient(hostRemote),
            payload,
          ),
        ),
      ).toBe('quizshow_adjust_below_zero');
    });

    it('acks host:createTeams with the new team ids and passes its refusal through', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const command = jest
        .spyOn(quizshowRoster, 'hostCreateTeams')
        .mockReturnValueOnce({
          ok: true,
          success: { isNoop: false, teamIds: [TEAM_ID] },
          effects: [],
        })
        .mockReturnValueOnce(
          refuse<{ isNoop: boolean; teamIds: string[] }>(
            'quizshow_teams_off',
            harness.state,
            false,
          ),
        );

      expect(
        await harness.gateway.handleHostCreateTeams(asClient(hostRemote), {
          names: ['Glitter'],
        }),
      ).toEqual({ ok: true, isNoop: false, teamIds: [TEAM_ID] });
      expect(command).toHaveBeenCalledWith(
        harness.state,
        ['Glitter'],
        expect.any(Number),
        harness.runtime.random,
      );
      expect(
        codeOf(
          await harness.gateway.handleHostCreateTeams(asClient(hostRemote), {
            names: ['Glitter'],
          }),
        ),
      ).toBe('quizshow_teams_off');
    });

    it('runs host:renamePlayer and host:movePlayer through the roster commands', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const rename = jest
        .spyOn(quizshowRoster, 'hostRenamePlayer')
        .mockReturnValueOnce(hostSuccess())
        .mockReturnValueOnce(hostRefusal('quizshow_player_left'));
      const move = jest
        .spyOn(quizshowRoster, 'hostMovePlayer')
        .mockReturnValueOnce(hostRefusal('quizshow_move_during_question'));

      expect(
        await harness.gateway.handleHostRenamePlayer(asClient(hostRemote), {
          playerId: TARGET_PLAYER_ID,
          screenName: 'Sasha',
        }),
      ).toEqual({ ok: true, isNoop: false });
      expect(rename).toHaveBeenCalledWith(
        harness.state,
        TARGET_PLAYER_ID,
        'Sasha',
        expect.any(Number),
      );
      expect(
        codeOf(
          await harness.gateway.handleHostRenamePlayer(asClient(hostRemote), {
            playerId: TARGET_PLAYER_ID,
            screenName: 'Sasha',
          }),
        ),
      ).toBe('quizshow_player_left');

      expect(
        codeOf(
          await harness.gateway.handleHostMovePlayer(asClient(hostRemote), {
            playerId: TARGET_PLAYER_ID,
            teamId: TEAM_ID,
          }),
        ),
      ).toBe('quizshow_move_during_question');
      expect(move).toHaveBeenCalledWith(
        harness.state,
        TARGET_PLAYER_ID,
        TEAM_ID,
        expect.any(Number),
      );
    });

    it('runs host:setJoinLock and host:setAutoAdvance through their engine commands', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const joinLock = jest
        .spyOn(quizshowSessionTools, 'hostSetJoinLock')
        .mockReturnValueOnce(hostSuccess());
      const autoAdvance = jest
        .spyOn(quizshowPhases, 'hostSetAutoAdvance')
        .mockReturnValueOnce(hostRefusal('quizshow_session_ended'));

      expect(
        await harness.gateway.handleHostSetJoinLock(asClient(hostRemote), {
          isLocked: true,
        }),
      ).toEqual({ ok: true, isNoop: false });
      expect(joinLock).toHaveBeenCalledWith(
        harness.state,
        true,
        expect.any(Number),
      );
      expect(
        codeOf(
          await harness.gateway.handleHostSetAutoAdvance(asClient(hostRemote), {
            isOn: false,
          }),
        ),
      ).toBe('quizshow_session_ended');
      expect(autoAdvance).toHaveBeenCalledWith(
        harness.state,
        false,
        expect.any(Number),
      );
    });

    it('passes canRejoin to hostRemovePlayer, false when the payload leaves it out', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const command = jest
        .spyOn(quizshowPhases, 'hostRemovePlayer')
        .mockReturnValue(hostSuccess());

      await harness.gateway.handleHostRemovePlayer(asClient(hostRemote), {
        playerId: TARGET_PLAYER_ID,
        canRejoin: true,
      });
      expect(command).toHaveBeenLastCalledWith(
        harness.state,
        TARGET_PLAYER_ID,
        HOST_USER_ID,
        expect.any(Number),
        harness.runtime.random,
        true,
      );
      await harness.gateway.handleHostRemovePlayer(asClient(hostRemote), {
        playerId: TARGET_PLAYER_ID,
      });
      expect(command).toHaveBeenLastCalledWith(
        harness.state,
        TARGET_PLAYER_ID,
        HOST_USER_ID,
        expect.any(Number),
        harness.runtime.random,
        false,
      );
    });

    it("acks host:notifyGuests with the sessions service's refusal code, and success when it returns null", async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      harness.sessionsService.notifyGuestsForSession.mockResolvedValueOnce(
        'quizshow_guest_push_cooldown',
      );
      // Both attempts reset the abandonment clock, as every host command does.
      harness.state.lastHostCommandAt = 0;

      expect(
        await harness.gateway.handleHostNotifyGuests(asClient(hostRemote), {}),
      ).toMatchObject({ ok: false, code: 'quizshow_guest_push_cooldown' });
      expect(
        harness.sessionsService.notifyGuestsForSession,
      ).toHaveBeenCalledWith(SESSION_ID);
      expect(harness.state.lastHostCommandAt).toBeGreaterThan(0);

      harness.state.lastHostCommandAt = 0;
      expect(
        await harness.gateway.handleHostNotifyGuests(asClient(hostRemote), {}),
      ).toEqual({ ok: true, isNoop: false });
      expect(harness.state.lastHostCommandAt).toBeGreaterThan(0);
    });

    it('refuses host:notifyGuests from a player socket before the sessions service runs', async () => {
      const { client: player } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      expect(
        codeOf(
          await harness.gateway.handleHostNotifyGuests(asClient(player), {}),
        ),
      ).toBe('quizshow_wrong_role');
      expect(
        harness.sessionsService.notifyGuestsForSession,
      ).not.toHaveBeenCalled();
    });
  });

  describe('player frames of the live v2 build', () => {
    it('runs lobby:leave through leaveLobby and passes its refusal through', async () => {
      const { client, me } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      const command = jest
        .spyOn(quizshowPhases, 'leaveLobby')
        .mockReturnValueOnce({ ok: true, success: {}, effects: [] })
        .mockReturnValueOnce(
          refuse('quizshow_session_ended', harness.state, false),
        );

      expect(
        await harness.gateway.handleLobbyLeave(asClient(client), {}),
      ).toEqual({ ok: true });
      expect(command).toHaveBeenCalledWith(
        harness.state,
        me.playerId,
        expect.any(Number),
        harness.runtime.random,
      );
      expect(
        codeOf(await harness.gateway.handleLobbyLeave(asClient(client), {})),
      ).toBe('quizshow_session_ended');
    });

    it('refuses the fourth reaction inside 1.5 s and never logs the player', async () => {
      const debugSpy = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined);
      const { client, me } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      const command = jest.spyOn(quizshowPlayers, 'sendReaction');
      const codes: Array<string | null> = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        codes.push(
          codeOf(
            await harness.gateway.handleReactionSend(asClient(client), {
              reactionId: 'heart',
            }),
          ),
        );
      }
      expect(codes).toEqual([null, null, null, 'quizshow_rate_limited']);
      expect(command).toHaveBeenCalledTimes(3);
      expect(command).toHaveBeenCalledWith(
        harness.state,
        me.playerId,
        'heart',
        expect.any(Number),
      );
      const everyLoggedValue = debugSpy.mock.calls
        .flat()
        .map((value: unknown) => String(value))
        .join('\n');
      expect(everyLoggedValue).toContain('reaction:send refused');
      expect(everyLoggedValue).not.toContain(me.playerId);
    });

    it('refuses a reaction from a socket that has not joined', async () => {
      const client = await connect(harness, 'socket-player', PLAYER_USER_ID);
      await attach(harness, client, 'player');
      expect(
        codeOf(
          await harness.gateway.handleReactionSend(asClient(client), {
            reactionId: 'clap',
          }),
        ),
      ).toBe('quizshow_not_joined');
    });

    it('carries the suggested screen name on a lobby:join refused for a taken name', async () => {
      await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID, 'Robin');
      const other = await connect(harness, 'socket-other', OUTSIDER_USER_ID);
      expect(await attach(harness, other, 'player')).toMatchObject({
        ok: true,
      });

      expect(await joinLobby(harness, other, 'Robin')).toMatchObject({
        ok: false,
        code: 'quizshow_screen_name_taken',
        suggestedScreenName: 'Robin 2',
      });
    });

    it('passes the socket latency allowance into submitAnswer', async () => {
      const { client, me } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      const command = jest.spyOn(quizshowPlayers, 'submitAnswer');
      client.data.rttSamples = [100, 200, 300];

      await submitAnswer(harness, client);
      expect(command).toHaveBeenCalledWith(
        harness.state,
        me.playerId,
        expect.objectContaining({ latencyAllowanceMs: 100 }) as unknown,
        expect.any(Number),
        harness.runtime.random,
      );
    });
  });

  describe('session:ping', () => {
    it('sends no ack to a socket that was never admitted', async () => {
      const client = makeClient('socket-unadmitted', PLAYER_USER_ID);
      client.data.admission = Promise.resolve(null);
      expect(
        await harness.gateway.handleSessionPing(asClient(client), {}),
      ).toBeUndefined();
    });

    it('acks an admitted socket with no session with a null phase id', async () => {
      const client = await connect(harness, 'socket-player', PLAYER_USER_ID);
      expect(
        await harness.gateway.handleSessionPing(asClient(client), {}),
      ).toEqual({
        ok: true,
        serverNow: expect.any(Number) as unknown,
        phaseId: null,
      });
    });

    it("acks an attached socket with the session's live phase id", async () => {
      const { client } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      expect(
        await harness.gateway.handleSessionPing(asClient(client), {}),
      ).toEqual({
        ok: true,
        serverNow: expect.any(Number) as unknown,
        phaseId: harness.state.cursor.phaseId,
      });
    });

    it('answers a null phase id from memory when the live state is gone, with no database load', async () => {
      const { client } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      jest.spyOn(harness.runtime, 'peekLiveState').mockReturnValue(null);
      const getOrLoad = jest.spyOn(harness.runtime, 'getOrLoad');
      harness.persistence.loadLiveState.mockClear();

      expect(
        await harness.gateway.handleSessionPing(asClient(client), {}),
      ).toEqual({
        ok: true,
        serverNow: expect.any(Number) as unknown,
        phaseId: null,
      });
      expect(getOrLoad).not.toHaveBeenCalled();
      expect(harness.persistence.loadLiveState).not.toHaveBeenCalled();
    });
  });

  describe('latency probes', () => {
    it('probes a player socket at attach and records a sample when the client acks', async () => {
      const { client } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      expect(client.probes).toHaveLength(1);
      const probe = client.probes[0];
      expect(probe?.event).toBe('time:probe');
      expect(probe?.timeoutMs).toBe(QUIZSHOW_LIMITS.latencyProbeTimeoutMs);
      expect(typeof probe?.payload.sentAt).toBe('number');

      probe?.acknowledge(null);
      const samples = client.data.rttSamples as number[];
      expect(samples).toHaveLength(1);
      expect(samples[0]).toBeGreaterThanOrEqual(0);
    });

    it('records nothing when a probe times out', async () => {
      const { client } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      client.probes[0]?.acknowledge(new Error('operation has timed out'));
      expect(client.data.rttSamples).toEqual([]);
    });

    it('never probes a host or screen socket', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      expect(hostRemote.probes).toHaveLength(0);
      expect(hostRemote.data.latencyProbeTimer).toBeUndefined();
    });

    it('clears the probe interval on disconnect', async () => {
      const { client } = await joinedPlayer(
        harness,
        'socket-player',
        PLAYER_USER_ID,
      );
      const timer = client.data.latencyProbeTimer;
      expect(timer).toBeDefined();
      const clearSpy = jest.spyOn(global, 'clearInterval');

      client.connected = false;
      harness.gateway.handleDisconnect(asClient(client));
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect(client.data.latencyProbeTimer).toBeUndefined();
    });

    describe('on the probe interval', () => {
      beforeEach(() => {
        // The attach flow awaits setImmediate; only the timers are faked.
        jest.useFakeTimers({
          doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
        });
      });

      it('probes again each interval and stops once the live state leaves memory', async () => {
        const { client } = await joinedPlayer(
          harness,
          'socket-player',
          PLAYER_USER_ID,
        );
        expect(client.probes).toHaveLength(1);

        jest.advanceTimersByTime(QUIZSHOW_LIMITS.latencyProbeIntervalMs);
        expect(client.probes).toHaveLength(2);

        const peek = jest
          .spyOn(harness.runtime, 'peekLiveState')
          .mockReturnValue(null);
        jest.advanceTimersByTime(QUIZSHOW_LIMITS.latencyProbeIntervalMs);
        expect(peek).toHaveBeenCalledWith(SESSION_ID);
        expect(client.probes).toHaveLength(2);
        expect(client.data.latencyProbeTimer).toBeUndefined();

        peek.mockRestore();
        jest.advanceTimersByTime(QUIZSHOW_LIMITS.latencyProbeIntervalMs);
        expect(client.probes).toHaveLength(2);
      });

      it('stops probing once the socket left the players room', async () => {
        const { client } = await joinedPlayer(
          harness,
          'socket-player',
          PLAYER_USER_ID,
        );
        expect(client.probes).toHaveLength(1);
        // Stands for a removal evicting the socket from the role rooms.
        client.rooms.delete(quizshowRoomName(SESSION_ID, 'players'));

        jest.advanceTimersByTime(QUIZSHOW_LIMITS.latencyProbeIntervalMs);
        expect(client.probes).toHaveLength(1);
        expect(client.data.latencyProbeTimer).toBeUndefined();
      });
    });
  });

  describe('a player socket attaching to a running roster', () => {
    it('runs returnAwayPlayer for a live player on attach', async () => {
      const { me } = await joinedPlayer(
        harness,
        'socket-phone',
        PLAYER_USER_ID,
      );
      const command = jest.spyOn(quizshowPlayers, 'returnAwayPlayer');
      const laptop = await connect(harness, 'socket-laptop', PLAYER_USER_ID);

      expect(await attach(harness, laptop, 'player')).toMatchObject({
        ok: true,
      });
      expect(laptop.data.playerId).toBe(me.playerId);
      expect(command).toHaveBeenCalledWith(
        harness.state,
        me.playerId,
        expect.any(Number),
      );
    });

    it('leaves a player who left unbound on attach, with no away return and their own name suggested', async () => {
      const { me } = await joinedPlayer(
        harness,
        'socket-phone',
        PLAYER_USER_ID,
        'Sasha',
      );
      const livePlayer = harness.state.players.get(me.playerId);
      if (livePlayer === undefined) throw new Error('player row missing');
      livePlayer.leftAt = START;
      const command = jest.spyOn(quizshowPlayers, 'returnAwayPlayer');
      const laptop = await connect(harness, 'socket-laptop', PLAYER_USER_ID);

      expect(await attach(harness, laptop, 'player')).toMatchObject({
        ok: true,
      });
      expect(laptop.data.playerId).toBeNull();
      expect(command).not.toHaveBeenCalled();
      await flushImmediate();
      // The profile's first name is Robin; the row played as Sasha.
      expect(clientEmits(laptop, 'session:state')).toEqual([
        expect.objectContaining({ me: null, suggestedScreenName: 'Sasha' }),
      ]);
    });

    it('asks consent again when a player who left rejoins a session that became 18+', async () => {
      const { client, me } = await joinedPlayer(
        harness,
        'socket-phone',
        PLAYER_USER_ID,
      );
      const livePlayer = harness.state.players.get(me.playerId);
      if (livePlayer === undefined) throw new Error('player row missing');
      // The player left, then a lobby refresh made the session 18+.
      livePlayer.leftAt = START;
      client.data.playerId = null;
      harness.state.isAdultsOnly = true;

      expect(codeOf(await joinLobby(harness, client))).toBe(
        'quizshow_adult_consent_required',
      );
      expect(livePlayer.leftAt).toBe(START);

      const accepted = await joinLobby(harness, client, 'Robin', true);
      expect(accepted).toMatchObject({
        ok: true,
        me: { playerId: me.playerId },
      });
      expect(livePlayer.leftAt).toBeNull();
    });

    it('leaves the private room again when the runtime unbinds the socket during the join', async () => {
      const { me } = await joinedPlayer(
        harness,
        'socket-phone',
        PLAYER_USER_ID,
      );
      const privateRoom = quizshowPlayerRoomName(SESSION_ID, me.playerId);
      const command = jest.spyOn(quizshowPlayers, 'returnAwayPlayer');
      const laptop = await connect(harness, 'socket-laptop', PLAYER_USER_ID);
      laptop.join.mockImplementation((room: string) => {
        // Stands for a leave landing while the join awaits.
        if (room === privateRoom) laptop.data.playerId = null;
        return Promise.resolve();
      });

      expect(await attach(harness, laptop, 'player')).toMatchObject({
        ok: true,
      });
      expect(laptop.leave).toHaveBeenCalledWith(privateRoom);
      expect(laptop.data.playerId).toBeNull();
      expect(command).not.toHaveBeenCalled();
    });
  });

  describe('paired screens and helper remotes', () => {
    const OTHER_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    /** The device starts a code, the host pairs it, and the device claims its ticket. */
    async function pairThroughHost(
      hostRemote: FakeClient,
      kind: 'screen' | 'helper',
      starterUserId: string | null = null,
    ): Promise<{ pairingId: string; deviceTicket: string }> {
      const start = harness.pairingService.startPairing(kind, starterUserId);
      const ack = await harness.gateway.handleHostPairDevice(
        asClient(hostRemote),
        { pairingCode: start.pairingCode },
      );
      if (!ack.ok) throw new Error(`host:pairDevice refused with ${ack.code}`);
      const claim = harness.pairingService.claimPairing(
        start.pairingId,
        start.pollToken,
      );
      if (claim.status !== 'paired') {
        throw new Error('the pairing was not completed');
      }
      return { pairingId: start.pairingId, deviceTicket: claim.deviceTicket };
    }

    /** A TV socket: a device ticket in the handshake and no member token. */
    async function connectScreen(
      socketId: string,
      deviceTicket: string,
    ): Promise<FakeClient> {
      const client = makeClient(socketId, 'no-member');
      client.handshake.auth = { deviceTicket };
      harness.sockets.set(socketId, client);
      client.disconnect.mockImplementation(() => {
        client.connected = false;
        harness.sockets.delete(socketId);
      });
      await harness.gateway.handleConnection(asClient(client));
      return client;
    }

    function attachWithTicket(
      client: FakeClient,
      role: QuizshowAttachRole,
      deviceTicket?: string,
      sessionId: string = SESSION_ID,
    ) {
      return harness.gateway.handleAttach(asClient(client), {
        sessionId,
        as: role,
        ...(deviceTicket === undefined ? {} : { deviceTicket }),
      });
    }

    function pairedDevice(pairingId: string) {
      const device = harness.state.pairedDevices.find(
        (candidate) => candidate.pairingId === pairingId,
      );
      if (device === undefined) throw new Error('no such paired device');
      return device;
    }

    it('pairs a screen: the ack carries the device, the claim hands over a ticket for this session, and hosts get devices:update', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const start = harness.pairingService.startPairing('screen', null);

      const ack = await harness.gateway.handleHostPairDevice(
        asClient(hostRemote),
        { pairingCode: start.pairingCode },
      );

      expect(ack).toEqual({
        ok: true,
        isNoop: false,
        device: expect.objectContaining({
          pairingId: start.pairingId,
          kind: 'screen',
          helperName: null,
        }) as unknown,
      });
      expect(pairedDevice(start.pairingId)).toMatchObject({
        kind: 'screen',
        helperUserId: null,
        revokedAt: null,
        connectedSocketCount: 0,
      });
      // Paired and not yet claimed, the code reads as used.
      expect(
        codeOf(
          await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
            pairingCode: start.pairingCode,
          }),
        ),
      ).toBe('quizshow_pairing_code_used');
      expect(harness.state.pairedDevices).toHaveLength(1);
      const claim = harness.pairingService.claimPairing(
        start.pairingId,
        start.pollToken,
      );
      expect(claim).toMatchObject({
        status: 'paired',
        sessionId: SESSION_ID,
        kind: 'event',
        eventSlug: 'pride-night',
        gameId: null,
      });
      if (claim.status !== 'paired') throw new Error('not paired');
      const claims = harness.pairingService.verifyDeviceTicket(
        claim.deviceTicket,
      );
      expect(claims).toMatchObject({
        typ: 'quizshow_device',
        sid: SESSION_ID,
        pid: start.pairingId,
        kind: 'screen',
      });
      expect(claims?.uid).toBeUndefined();
      expect(
        roomEmitsOf(harness, 'devices:update').map((record) => record.room),
      ).toContain(quizshowRoomName(SESSION_ID, 'hosts'));
    });

    it('passes the code lookup refusal through and adds no device', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      expect(
        codeOf(
          await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
            pairingCode: '234567',
          }),
        ),
      ).toBe('quizshow_pairing_code_not_found');
      expect(harness.state.pairedDevices).toHaveLength(0);
    });

    it('refuses the seventh device with paired devices full and leaves its code waiting', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      for (let deviceNumber = 1; deviceNumber <= 6; deviceNumber += 1) {
        await pairThroughHost(hostRemote, 'screen');
      }
      const seventh = harness.pairingService.startPairing('screen', null);

      expect(
        codeOf(
          await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
            pairingCode: seventh.pairingCode,
          }),
        ),
      ).toBe('quizshow_paired_devices_full');
      expect(harness.state.pairedDevices).toHaveLength(6);
      expect(
        harness.pairingService.claimPairing(
          seventh.pairingId,
          seventh.pollToken,
        ).status,
      ).toBe('waiting');
    });

    it('admits a screen ticket with no member token and refuses a bad ticket or a helper ticket with UNAUTHORIZED', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const screenPairing = await pairThroughHost(hostRemote, 'screen');
      const helperPairing = await pairThroughHost(
        hostRemote,
        'helper',
        OUTSIDER_USER_ID,
      );
      const verifiedTokenCount = harness.jwt.verifyAsync.mock.calls.length;

      const screen = await connectScreen(
        'socket-tv',
        screenPairing.deviceTicket,
      );
      expect(screen.disconnect).not.toHaveBeenCalled();
      expect(screen.data.userId).toBeUndefined();
      expect(screen.data.device).toEqual({
        pairingId: screenPairing.pairingId,
        sessionId: SESSION_ID,
        kind: 'screen',
      });
      expect(harness.jwt.verifyAsync).toHaveBeenCalledTimes(verifiedTokenCount);

      const refusedHandshakes: Array<[string, string]> = [
        ['socket-forged', 'not-a-ticket'],
        ['socket-helper-ticket', helperPairing.deviceTicket],
      ];
      for (const [socketId, deviceTicket] of refusedHandshakes) {
        const refused = await connectScreen(socketId, deviceTicket);
        expect(refused.emit).toHaveBeenCalledWith(
          'exception',
          expect.objectContaining({ code: 'UNAUTHORIZED' }),
        );
        expect(refused.disconnect).toHaveBeenCalledWith(true);
        expect(refused.data.device).toBeUndefined();
      }
    });

    it('admits a ticket beside a member cookie as the screen, and takes the member path for an explicit token', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const { pairingId, deviceTicket } = await pairThroughHost(
        hostRemote,
        'screen',
      );
      const verifiedTokenCount = harness.jwt.verifyAsync.mock.calls.length;
      const cookieBrowser = makeClient('socket-cookie', PLAYER_USER_ID);
      cookieBrowser.handshake.auth = { deviceTicket };
      cookieBrowser.handshake.headers = {
        cookie: `access_token=${PLAYER_USER_ID}`,
      };
      await harness.gateway.handleConnection(asClient(cookieBrowser));

      expect(cookieBrowser.disconnect).not.toHaveBeenCalled();
      expect(cookieBrowser.data.userId).toBeUndefined();
      expect(cookieBrowser.data.device).toEqual({
        pairingId,
        sessionId: SESSION_ID,
        kind: 'screen',
      });
      expect(harness.jwt.verifyAsync).toHaveBeenCalledTimes(verifiedTokenCount);

      const tokenClient = makeClient('socket-token', PLAYER_USER_ID);
      tokenClient.handshake.auth = { token: PLAYER_USER_ID, deviceTicket };
      await harness.gateway.handleConnection(asClient(tokenClient));
      expect(tokenClient.data.userId).toBe(PLAYER_USER_ID);
      expect(tokenClient.data.device).toBeUndefined();

      // An empty ticket is no ticket: the cookie takes the member path.
      const emptyTicketClient = makeClient('socket-empty', PLAYER_USER_ID);
      emptyTicketClient.handshake.auth = { deviceTicket: '' };
      emptyTicketClient.handshake.headers = {
        cookie: `access_token=${PLAYER_USER_ID}`,
      };
      await harness.gateway.handleConnection(asClient(emptyTicketClient));
      expect(emptyTicketClient.data.userId).toBe(PLAYER_USER_ID);
      expect(emptyTicketClient.data.device).toBeUndefined();
    });

    it('lets one of two racing host:pairDevice frames with one code add the device and acks the other as used', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const laptopRemote = await attachedHost(harness, 'socket-laptop');
      const start = harness.pairingService.startPairing('screen', null);

      const acks = await Promise.all([
        harness.gateway.handleHostPairDevice(asClient(hostRemote), {
          pairingCode: start.pairingCode,
        }),
        harness.gateway.handleHostPairDevice(asClient(laptopRemote), {
          pairingCode: start.pairingCode,
        }),
      ]);

      expect(acks.filter((ack) => ack.ok)).toHaveLength(1);
      expect(acks.map((ack) => codeOf(ack))).toContain(
        'quizshow_pairing_code_used',
      );
      expect(harness.state.pairedDevices).toHaveLength(1);
      expect(pairedDevice(start.pairingId).revokedAt).toBeNull();
      expect(
        harness.pairingService.claimPairing(start.pairingId, start.pollToken)
          .status,
      ).toBe('paired');
    });

    it('passes too many tries through once the host missed ten codes', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      for (let missNumber = 1; missNumber <= 10; missNumber += 1) {
        harness.pairingService.findPendingByCode('234567', HOST_USER_ID);
      }
      const start = harness.pairingService.startPairing('screen', null);

      expect(
        codeOf(
          await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
            pairingCode: start.pairingCode,
          }),
        ),
      ).toBe('quizshow_pairing_too_many_tries');
      expect(harness.state.pairedDevices).toHaveLength(0);
    });

    it('unpairs the device it just added when the pending entry is gone before the ticket lands', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const keptPairing = await pairThroughHost(hostRemote, 'screen');
      const start = harness.pairingService.startPairing('screen', null);
      jest
        .spyOn(harness.pairingService, 'completePairing')
        .mockReturnValueOnce(false);

      expect(
        codeOf(
          await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
            pairingCode: start.pairingCode,
          }),
        ),
      ).toBe('quizshow_pairing_code_used');
      expect(pairedDevice(start.pairingId).revokedAt).not.toBeNull();
      expect(pairedDevice(keptPairing.pairingId).revokedAt).toBeNull();
    });

    it('lets a screen socket attach only as screen to its own session and refuses every member frame with wrong role', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const { deviceTicket } = await pairThroughHost(hostRemote, 'screen');
      const screen = await connectScreen('socket-tv', deviceTicket);

      expect(codeOf(await joinLobby(harness, screen))).toBe(
        'quizshow_wrong_role',
      );
      expect(codeOf(await hostNext(harness, screen, '0'))).toBe(
        'quizshow_wrong_role',
      );
      expect(
        await harness.gateway.handleReauth(asClient(screen), {
          ticket: 'socket-ticket',
        }),
      ).toMatchObject({ ok: false, code: 'quizshow_wrong_role' });
      expect(codeOf(await attachWithTicket(screen, 'host'))).toBe(
        'quizshow_wrong_role',
      );
      expect(
        codeOf(
          await attachWithTicket(screen, 'screen', undefined, OTHER_SESSION_ID),
        ),
      ).toBe('quizshow_wrong_role');
      expect(screen.join).not.toHaveBeenCalled();

      expect(await attachWithTicket(screen, 'screen')).toMatchObject({
        ok: true,
        role: 'screen',
      });
      expect(screen.join).toHaveBeenCalledWith(
        quizshowRoomName(SESSION_ID, 'screen'),
      );

      await harness.gateway.handleTimePing(asClient(screen), {
        clientSentAt: 1,
      });
      expect(clientEmits(screen, 'time:pong')).toHaveLength(1);
      expect(
        await harness.gateway.handleSessionPing(asClient(screen), {}),
      ).toMatchObject({ ok: true, phaseId: harness.state.cursor.phaseId });
    });

    it('refuses the attach of an unpaired screen with device unpaired', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const { pairingId, deviceTicket } = await pairThroughHost(
        hostRemote,
        'screen',
      );
      expect(
        await harness.gateway.handleHostUnpairDevice(asClient(hostRemote), {
          pairingId,
        }),
      ).toEqual({ ok: true, isNoop: false });

      const screen = await connectScreen('socket-tv', deviceTicket);
      expect(codeOf(await attachWithTicket(screen, 'screen'))).toBe(
        'quizshow_device_unpaired',
      );
      expect(screen.data.role).toBeUndefined();
      expect(screen.join).not.toHaveBeenCalled();
    });

    it('moves the device socket count on a screen attach and on its disconnect', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const { pairingId, deviceTicket } = await pairThroughHost(
        hostRemote,
        'screen',
      );
      const screen = await connectScreen('socket-tv', deviceTicket);
      expect(await attachWithTicket(screen, 'screen')).toMatchObject({
        ok: true,
      });
      expect(pairedDevice(pairingId).connectedSocketCount).toBe(1);

      harness.gateway.handleDisconnect(asClient(screen));
      expect(pairedDevice(pairingId).connectedSocketCount).toBe(0);
    });

    it('unpairs a screen: device:unpaired to its socket, then the drop', async () => {
      const hostRemote = await attachedHost(harness, 'socket-host');
      const { pairingId, deviceTicket } = await pairThroughHost(
        hostRemote,
        'screen',
      );
      const screen = await connectScreen('socket-tv', deviceTicket);
      const otherScreen = await connectScreen(
        'socket-other-tv',
        (await pairThroughHost(hostRemote, 'screen')).deviceTicket,
      );
      expect(await attachWithTicket(screen, 'screen')).toMatchObject({
        ok: true,
      });

      expect(
        await harness.gateway.handleHostUnpairDevice(asClient(hostRemote), {
          pairingId,
        }),
      ).toEqual({ ok: true, isNoop: false });

      expect(clientEmits(screen, 'device:unpaired')).toEqual([{ pairingId }]);
      expect(screen.disconnect).toHaveBeenCalledWith(true);
      expect(pairedDevice(pairingId).revokedAt).not.toBeNull();
      expect(clientEmits(otherScreen, 'device:unpaired')).toHaveLength(0);
      expect(otherScreen.disconnect).not.toHaveBeenCalled();
      expect(
        codeOf(
          await harness.gateway.handleHostUnpairDevice(asClient(hostRemote), {
            pairingId,
          }),
        ),
      ).toBe('quizshow_device_not_found');
    });

    describe('a helper remote', () => {
      beforeEach(() => {
        jest
          .spyOn(launchedFeatures, 'isFeatureLaunched')
          .mockReturnValue(false);
        jest
          .spyOn(launchedFeatures, 'isEarlyAccessFeature')
          .mockReturnValue(true);
        harness.ungrantedUserIds.add(OUTSIDER_USER_ID);
      });

      it('attaches without the grant, records the organiser, runs host:next and refuses the pairing commands', async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { pairingId, deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        expect(pairedDevice(pairingId)).toMatchObject({
          kind: 'helper',
          helperUserId: OUTSIDER_USER_ID,
          helperName: 'Robin',
        });
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );
        harness.featureAccess.canUseFeature.mockClear();
        harness.eventsService.isOrganizer.mockClear();
        harness.eventsService.assertCanView.mockClear();

        expect(
          await attachWithTicket(helperPhone, 'host', deviceTicket),
        ).toMatchObject({ ok: true, role: 'host' });
        expect(helperPhone.data.helperPairingId).toBe(pairingId);
        expect(helperPhone.join).toHaveBeenCalledWith(
          quizshowRoomName(SESSION_ID, 'hosts'),
        );
        expect(
          harness.state.attachedOrganiserUserIds.has(OUTSIDER_USER_ID),
        ).toBe(true);
        expect(pairedDevice(pairingId).connectedSocketCount).toBe(1);
        expect(harness.featureAccess.canUseFeature).not.toHaveBeenCalled();
        // The attach ran the event's view and ban checks for the helper.
        expect(harness.eventsService.assertCanView).toHaveBeenCalledWith(
          expect.anything(),
          OUTSIDER_USER_ID,
        );
        harness.eventsService.isOrganizer.mockClear();
        harness.eventsService.assertCanView.mockClear();

        const command = jest.spyOn(quizshowPhases, 'hostNext').mockReturnValue({
          ok: true,
          success: { isNoop: false },
          effects: [],
        });
        expect(
          await hostNext(harness, helperPhone, harness.state.cursor.phaseId),
        ).toEqual({ ok: true, isNoop: false });
        expect(command).toHaveBeenCalled();
        expect(harness.featureAccess.canUseFeature).not.toHaveBeenCalled();
        expect(harness.eventsService.isOrganizer).not.toHaveBeenCalled();
        expect(harness.eventsService.assertCanView).not.toHaveBeenCalled();

        const screenCode = harness.pairingService.startPairing('screen', null);
        expect(
          codeOf(
            await harness.gateway.handleHostPairDevice(asClient(helperPhone), {
              pairingCode: screenCode.pairingCode,
            }),
          ),
        ).toBe('quizshow_helper_cannot_pair');
        expect(
          codeOf(
            await harness.gateway.handleHostUnpairDevice(
              asClient(helperPhone),
              { pairingId },
            ),
          ),
        ).toBe('quizshow_helper_cannot_pair');
        expect(pairedDevice(pairingId).revokedAt).toBeNull();

        harness.gateway.handleDisconnect(asClient(helperPhone));
        expect(pairedDevice(pairingId).connectedSocketCount).toBe(0);
      });

      it("refuses a helper ticket on another member's socket, for another session or as a screen ticket with ticket expired", async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const helperPairing = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        const screenPairing = await pairThroughHost(hostRemote, 'screen');
        const strangerPhone = await connect(
          harness,
          'socket-stranger',
          STRANGER_USER_ID,
        );
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );

        expect(
          codeOf(
            await attachWithTicket(
              strangerPhone,
              'host',
              helperPairing.deviceTicket,
            ),
          ),
        ).toBe('quizshow_device_ticket_expired');
        expect(
          codeOf(
            await attachWithTicket(
              helperPhone,
              'host',
              helperPairing.deviceTicket,
              OTHER_SESSION_ID,
            ),
          ),
        ).toBe('quizshow_device_ticket_expired');
        expect(
          codeOf(
            await attachWithTicket(
              helperPhone,
              'host',
              screenPairing.deviceTicket,
            ),
          ),
        ).toBe('quizshow_device_ticket_expired');
        expect(
          codeOf(await attachWithTicket(helperPhone, 'host', 'not-a-ticket')),
        ).toBe('quizshow_device_ticket_expired');
        expect(strangerPhone.data.role).toBeUndefined();
        expect(helperPhone.data.role).toBeUndefined();
        expect(
          harness.state.attachedOrganiserUserIds.has(STRANGER_USER_ID),
        ).toBe(false);
      });

      it('refuses a helper who holds a player row, at pairing and at attach, with helper is playing', async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        await joinedPlayer(harness, 'socket-player', PLAYER_USER_ID);
        const playingStarter = harness.pairingService.startPairing(
          'helper',
          PLAYER_USER_ID,
        );
        expect(
          codeOf(
            await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
              pairingCode: playingStarter.pairingCode,
            }),
          ),
        ).toBe('quizshow_helper_is_playing');

        const { deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        await joinedPlayer(
          harness,
          'socket-outsider-player',
          OUTSIDER_USER_ID,
          'Sasha',
        );
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );
        expect(
          codeOf(await attachWithTicket(helperPhone, 'host', deviceTicket)),
        ).toBe('quizshow_helper_is_playing');
        expect(helperPhone.data.helperPairingId).toBeUndefined();
      });

      it('pairs and attaches a member whose player row left the game as a helper', async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { me } = await joinedPlayer(
          harness,
          'socket-player',
          PLAYER_USER_ID,
        );
        const leftPlayer = harness.state.players.get(me.playerId);
        if (leftPlayer === undefined) throw new Error('player row missing');
        leftPlayer.leftAt = Date.now();

        const { deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          PLAYER_USER_ID,
        );
        const helperPhone = await connect(
          harness,
          'socket-helper',
          PLAYER_USER_ID,
        );
        expect(
          await attachWithTicket(helperPhone, 'host', deviceTicket),
        ).toMatchObject({ ok: true, role: 'host' });
      });

      it('refuses an expired helper ticket at attach, and a host frame once the ticket passed its exp', async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { pairingId, deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        const expiredTicket = harness.pairingService.mintDeviceTicket({
          sessionId: SESSION_ID,
          pairingId,
          kind: 'helper',
          helperUserId: OUTSIDER_USER_ID,
          now: Date.now() - QUIZSHOW_LIMITS.deviceTicketTtlMs - 60_000,
        });
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );
        expect(
          codeOf(await attachWithTicket(helperPhone, 'host', expiredTicket)),
        ).toBe('quizshow_device_ticket_expired');
        expect(helperPhone.data.role).toBeUndefined();

        expect(
          await attachWithTicket(helperPhone, 'host', deviceTicket),
        ).toMatchObject({ ok: true });
        expect(helperPhone.data.helperTicketExp).toBe(
          harness.pairingService.verifyDeviceTicket(deviceTicket)?.exp,
        );
        // Stands for the clock passing the ticket's exp.
        helperPhone.data.helperTicketExp = Math.floor(Date.now() / 1000) - 1;
        const command = jest.spyOn(quizshowPhases, 'hostNext');
        expect(
          codeOf(
            await hostNext(harness, helperPhone, harness.state.cursor.phaseId),
          ),
        ).toBe('quizshow_device_ticket_expired');
        expect(command).not.toHaveBeenCalled();
      });

      it('refuses a helper who cannot see the event (not found at attach, cannot view event at pairing) or is blocked with its host (barred at attach, cannot view event at pairing)', async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );

        harness.hiddenFromUserIds.add(OUTSIDER_USER_ID);
        expect(
          codeOf(await attachWithTicket(helperPhone, 'host', deviceTicket)),
        ).toBe('quizshow_session_not_found');
        const hiddenStart = harness.pairingService.startPairing(
          'helper',
          OUTSIDER_USER_ID,
        );
        expect(
          codeOf(
            await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
              pairingCode: hiddenStart.pairingCode,
            }),
          ),
        ).toBe('quizshow_cannot_view_event');

        harness.hiddenFromUserIds.delete(OUTSIDER_USER_ID);
        harness.blockFilter.isBlockedEitherWay.mockResolvedValue(true);
        expect(
          codeOf(await attachWithTicket(helperPhone, 'host', deviceTicket)),
        ).toBe('quizshow_banned_from_event');
        // The pairing host never learns of a block between two other members.
        expect(
          codeOf(
            await harness.gateway.handleHostPairDevice(asClient(hostRemote), {
              pairingCode: hiddenStart.pairingCode,
            }),
          ),
        ).toBe('quizshow_cannot_view_event');
        expect(helperPhone.data.role).toBeUndefined();
        expect(harness.state.pairedDevices).toHaveLength(1);
      });

      it('refuses a helper blocked either way with the game owner: barred at attach, cannot view event at pairing', async () => {
        replaceHarness({ kind: 'game' });
        const ownerRemote = await attachedHost(
          harness,
          'socket-owner',
          OWNER_USER_ID,
        );
        const { deviceTicket } = await pairThroughHost(
          ownerRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        harness.blockFilter.isBlockedEitherWay.mockResolvedValue(true);
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );

        expect(
          codeOf(await attachWithTicket(helperPhone, 'host', deviceTicket)),
        ).toBe('quizshow_banned_from_event');
        expect(harness.blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
          OWNER_USER_ID,
          OUTSIDER_USER_ID,
        );
        const blockedStart = harness.pairingService.startPairing(
          'helper',
          OUTSIDER_USER_ID,
        );
        expect(
          codeOf(
            await harness.gateway.handleHostPairDevice(asClient(ownerRemote), {
              pairingCode: blockedStart.pairingCode,
            }),
          ),
        ).toBe('quizshow_cannot_view_event');
      });

      it("drops a helper socket at its ticket's exp when that comes before the member token's", async () => {
        jest.useFakeTimers({
          doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
        });
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { pairingId } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        // A ticket with 60 s left; the member token has 900 s.
        const shortTicket = harness.pairingService.mintDeviceTicket({
          sessionId: SESSION_ID,
          pairingId,
          kind: 'helper',
          helperUserId: OUTSIDER_USER_ID,
          now: Date.now() - QUIZSHOW_LIMITS.deviceTicketTtlMs + 60_000,
        });
        const ticketExp =
          harness.pairingService.verifyDeviceTicket(shortTicket)?.exp ?? 0;
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );

        expect(
          await attachWithTicket(helperPhone, 'host', shortTicket),
        ).toMatchObject({
          ok: true,
          role: 'host',
          connectionExpiresAt: ticketExp * 1000,
        });
        jest.advanceTimersByTime(ticketExp * 1000 - Date.now() - 1_000);
        expect(helperPhone.disconnect).not.toHaveBeenCalled();

        jest.advanceTimersByTime(2_000);
        expect(helperPhone.emit).toHaveBeenCalledWith(
          'exception',
          expect.objectContaining({ status: 'error', code: 'TOKEN_EXPIRED' }),
        );
        expect(helperPhone.disconnect).toHaveBeenCalledWith(true);
      });

      it("re-arms a helper's drop at its ticket's exp on a good session:reauth and acks that limit", async () => {
        jest.useFakeTimers({
          doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
        });
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { pairingId } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        // A ticket with 60 s left; the fresh member token gets 15 minutes.
        const shortTicket = harness.pairingService.mintDeviceTicket({
          sessionId: SESSION_ID,
          pairingId,
          kind: 'helper',
          helperUserId: OUTSIDER_USER_ID,
          now: Date.now() - QUIZSHOW_LIMITS.deviceTicketTtlMs + 60_000,
        });
        const ticketExp =
          harness.pairingService.verifyDeviceTicket(shortTicket)?.exp ?? 0;
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );
        expect(
          await attachWithTicket(helperPhone, 'host', shortTicket),
        ).toMatchObject({ ok: true });

        const { ticket } = socketTicketService.mint(
          OUTSIDER_USER_ID,
          `family-${OUTSIDER_USER_ID}`,
          UserStatus.Active,
          15 * 60_000,
        );
        expect(
          await harness.gateway.handleReauth(asClient(helperPhone), { ticket }),
        ).toEqual({ ok: true, exp: ticketExp });
        expect(helperPhone.data.exp).toBeGreaterThan(ticketExp);

        jest.advanceTimersByTime(ticketExp * 1000 - Date.now() - 1_000);
        expect(helperPhone.disconnect).not.toHaveBeenCalled();

        jest.advanceTimersByTime(2_000);
        expect(helperPhone.emit).toHaveBeenCalledWith(
          'exception',
          expect.objectContaining({ status: 'error', code: 'TOKEN_EXPIRED' }),
        );
        expect(helperPhone.disconnect).toHaveBeenCalledWith(true);
      });

      it("refuses a helper's session:reauth once its ticket's exp passed and drops the socket", async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );
        expect(
          await attachWithTicket(helperPhone, 'host', deviceTicket),
        ).toMatchObject({ ok: true });
        const redeem = jest.spyOn(socketTicketService, 'redeem');
        // Stands for the clock passing the ticket's exp.
        helperPhone.data.helperTicketExp = Math.floor(Date.now() / 1000) - 1;

        expect(
          await harness.gateway.handleReauth(asClient(helperPhone), {
            ticket: 'socket-ticket',
          }),
        ).toMatchObject({ ok: false, code: 'quizshow_device_ticket_expired' });
        expect(redeem).not.toHaveBeenCalled();
        expect(helperPhone.disconnect).toHaveBeenCalledWith(true);
      });

      it('drops an unpaired helper with device:unpaired and refuses its next command with device unpaired', async () => {
        const hostRemote = await attachedHost(harness, 'socket-host');
        const { pairingId, deviceTicket } = await pairThroughHost(
          hostRemote,
          'helper',
          OUTSIDER_USER_ID,
        );
        const helperPhone = await connect(
          harness,
          'socket-helper',
          OUTSIDER_USER_ID,
        );
        expect(
          await attachWithTicket(helperPhone, 'host', deviceTicket),
        ).toMatchObject({ ok: true });

        expect(
          await harness.gateway.handleHostUnpairDevice(asClient(hostRemote), {
            pairingId,
          }),
        ).toEqual({ ok: true, isNoop: false });

        expect(clientEmits(helperPhone, 'device:unpaired')).toEqual([
          { pairingId },
        ]);
        expect(helperPhone.disconnect).toHaveBeenCalledWith(true);
        expect(hostRemote.disconnect).not.toHaveBeenCalled();
        expect(
          codeOf(
            await hostNext(harness, helperPhone, harness.state.cursor.phaseId),
          ),
        ).toBe('quizshow_device_unpaired');
      });
    });
  });
});
