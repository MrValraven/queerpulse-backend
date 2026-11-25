/**
 * Pulse Live (`quizshow`) socket namespace `/quizshow`. The handshake copies
 * the magazine desk gateway (origin allowlist, cookie or `auth.token`, pinned
 * JWT verify, a handshake bucket on the verified user, live status, lockdown
 * and a live refresh-token family) and checks feature access itself, since
 * the global feature guards cover HTTP only: every active member is admitted
 * while Pulse Live is launched or in early access, and grants are never read
 * for playing. Hosting stays gated: a screen or host attach and every host
 * command check the early-access grant, and `session:reauth` checks it again
 * for a screen or host socket, so a revoke drops a live host socket at its
 * next reauth. The socket is dropped at the token's `exp` with
 * `TOKEN_EXPIRED`; `session:reauth` with a socket ticket extends it, as on
 * `/chat`.
 *
 * Paired devices (contract 4.4, 6.5, 13): a TV holding a screen ticket and
 * no explicit `auth.token` is admitted as a device socket, whatever cookie it
 * carries, and may only attach as the screen of its ticket's session and
 * ping. A helper remote is a member socket whose host attach carries a
 * helper ticket naming that member; the pairing stands in for the grant and
 * organiser checks and is read again on every host command, the helper meets
 * the scope's view, ban and block checks, and the ticket's `exp` caps its
 * rights. An unpair drops every socket holding the pairing.
 *
 * Every client frame is routed to the runtime, which owns the live state.
 * Domain refusals come back as failure acks; transport refusals as the chat
 * `exception` frame. Log lines name frames, codes, session ids and player ids
 * only: payloads, answer text, screen names and team names stay out.
 */
import {
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { parseCookie } from 'cookie';
import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import {
  USER_SESSION_REVOKED,
  type UserSessionRevokedEvent,
} from '../chat/session.events';
import { TokenBucketLimiter } from '../chat/ws-rate-limiter';
import { WsAllExceptionsFilter } from '../chat/ws-exception.filter';
import {
  buildChatWsErrorFrame,
  ChatWsException,
  type ChatWsErrorCode,
  type ChatWsErrorFrame,
} from '../chat/ws-error';
import { DEFAULT_LOCKDOWN_MESSAGE } from '../common/lockdown.constants';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import {
  resolveAllowedOrigins,
  resolveFrontendOrigins,
} from '../config/frontend-origins';
import { FeatureAccessService } from '../early-access/feature-access.service';
import { EventsService } from '../events/events.service';
import { PLATFORM_LOCKDOWN_ENABLED } from '../platform-settings/platform-settings.events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  QuizshowAcceptAnswerPayload,
  QuizshowAddTimePayload,
  QuizshowAdjustPointsPayload,
  QuizshowAnswerPayloadDto,
  QuizshowAnswerSubmitPayload,
  QuizshowAttachPayload,
  QuizshowAvatarPayload,
  QuizshowChangeCorrectAnswerPayload,
  QuizshowCorrectAnswerChangeDto,
  QuizshowCreateTeamPayload,
  QuizshowCreateTeamsPayload,
  QuizshowExtraTimePayload,
  QuizshowHideAnswerPayload,
  QuizshowJokerPayload,
  QuizshowLeavePayload,
  QuizshowLobbyJoinPayload,
  QuizshowLobbyTeamChoiceDto,
  QuizshowMovePlayerPayload,
  QuizshowNotifyGuestsPayload,
  QuizshowPairDevicePayload,
  QuizshowPhaseCommandPayload,
  QuizshowPickFavouritePayload,
  QuizshowPickTeamPayload,
  QuizshowReactionPayload,
  QuizshowReauthPayload,
  QuizshowRemovePlayerPayload,
  QuizshowRenamePlayerPayload,
  QuizshowRenameTeamPayload,
  QuizshowSessionPingPayload,
  QuizshowSetAutoAdvancePayload,
  QuizshowSetJoinLockPayload,
  QuizshowSetNamePayload,
  QuizshowSetScreenMutedPayload,
  QuizshowTimePingPayload,
  QuizshowUnpairDevicePayload,
  QuizshowVoteSubmitPayload,
} from './dto/quizshow-socket-payloads';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import {
  QuizshowAccessService,
  type QuizshowMayPlayInput,
} from './quizshow-access.service';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_OPEN_SESSION_STATUSES,
  type QuizshowAck,
  type QuizshowAckFailure,
  type QuizshowAnswerPayload,
  type QuizshowAttachRole,
  type QuizshowErrorCode,
  type QuizshowMe,
  type QuizshowMyAnswer,
  type QuizshowMyVote,
  type QuizshowPairedDevice,
  type QuizshowSessionStatus,
} from './quizshow.contract';
import { QuizshowDevicePairingService } from './quizshow-device-pairing.service';
import {
  hostAddTime,
  hostEnd,
  hostActed,
  hostFinishWheel,
  hostHideAnswer,
  hostNext,
  hostPause,
  hostPickFavourite,
  hostRemovePlayer,
  hostRenameTeam,
  hostResume,
  hostReveal,
  hostSetAutoAdvance,
  hostSetScreenMuted,
  hostShowAnswers,
  hostSkip,
  hostSpin,
  hostStart,
  leaveLobby,
} from './quizshow-engine-phases';
import {
  createTeam,
  joinLobby,
  pickTeam,
  playJoker,
  returnAwayPlayer,
  sendReaction,
  setAvatarShown,
  setExtraTime,
  setScreenName,
  submitAnswer,
  submitVote,
  type QuizshowJoinTeamChoice,
} from './quizshow-engine-players';
import {
  hostAcceptAnswer,
  hostAdjustPoints,
  hostChangeCorrectAnswer,
  type QuizshowChoiceAnswerChange,
} from './quizshow-engine-rescore';
import {
  hostCreateTeams,
  hostMovePlayer,
  hostRenamePlayer,
} from './quizshow-engine-roster';
import {
  hostAddPairedDevice,
  hostRevokePairedDevice,
  hostSetJoinLock,
} from './quizshow-engine-session-tools';
import {
  isActivePlayer,
  recordAttachedOrganiser,
  refuse,
  statusRefusalCode,
  toMe,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowLivePairedDevice,
  QuizshowLivePlayer,
  QuizshowLiveState,
} from './quizshow-engine-types';
import { quizshowAckFailure, quizshowCodeOf } from './quizshow-errors';
import { latencyAllowanceMs, withRttSample } from './quizshow-latency';
import {
  buildSessionState,
  quizshowPlayerRoomName,
  quizshowRoomName,
  type QuizshowSessionStateViewer,
} from './quizshow-frames';
import { quizshowWriteFailureCode } from './quizshow-persistence.service';
import {
  quizshowHelperNameFromFirstName,
  quizshowScreenNameFromFirstName,
} from './quizshow-helper-name';
import { isQuizshowPlayable } from './quizshow-play-rules';
import {
  QuizshowRuntimeService,
  type QuizshowExecuteOptions,
} from './quizshow-runtime.service';
import { QuizshowSessionsService } from './quizshow-sessions.service';

/** The handshake and reauth budget per verified user: a burst of 10, then one every 10 seconds. */
const HANDSHAKE_RATE_LIMIT = { capacity: 10, refillPerSecond: 0.1 };
const REAUTH_RATE_LIMIT = { capacity: 10, refillPerSecond: 0.1 };
/** `quizshow:attach` per socket: 10, then one every 6 seconds. */
const ATTACH_RATE_LIMIT = { capacity: 10, refillPerSecond: 1 / 6 };
/** `lobby:*`, `settings:*` and `joker:play` per user: 10, then one per second. */
const PLAYER_SETTINGS_RATE_LIMIT = { capacity: 10, refillPerSecond: 1 };
/** `answer:submit` and `vote:submit` per player: 5, then one per second. */
const SUBMISSION_RATE_LIMIT = { capacity: 5, refillPerSecond: 1 };
/** `host:*` per user: 20, then 5 per second. */
const HOST_RATE_LIMIT = { capacity: 20, refillPerSecond: 5 };
/** `time:ping` per socket: 10, then one every 6 seconds; past it pings are dropped. */
const TIME_PING_RATE_LIMIT = { capacity: 10, refillPerSecond: 1 / 6 };
/** `reaction:send` per player (contract 6.19): `reactionBurst`, then one every `reactionRefillMs`. */
const REACTION_RATE_LIMIT = {
  capacity: QUIZSHOW_LIMITS.reactionBurst,
  refillPerSecond: 1000 / QUIZSHOW_LIMITS.reactionRefillMs,
};

/** How often fully refilled buckets are reclaimed. */
const BUCKET_SWEEP_INTERVAL_MS = 60_000;

/** `setTimeout` clamps a longer delay to 1 ms, so the expiry timer chains legs of at most this length. */
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

const FEATURE_HIDDEN_MESSAGE = 'This feature is not available yet.';

const OPEN_STATUSES: ReadonlySet<QuizshowSessionStatus> =
  new Set<QuizshowSessionStatus>(QUIZSHOW_OPEN_SESSION_STATUSES);

/** Refusals a client can repeat at no cost before any bucket applies; they get no log line, so a flood cannot fill the log. */
const UNLOGGED_REFUSALS: ReadonlySet<QuizshowErrorCode> =
  new Set<QuizshowErrorCode>([
    'quizshow_not_attached',
    'quizshow_wrong_role',
    'quizshow_not_joined',
  ]);

/** Frames whose refusal log lines leave the player id out: reactions are anonymous (contract 6.19). */
const ANONYMOUS_FRAMES: ReadonlySet<string> = new Set<string>([
  'reaction:send',
]);

/** Verified access-token claims the handshake reads. */
interface AccessTokenClaims {
  sub: string;
  status: UserStatus;
  exp: number;
  sid?: string;
}

interface QuizshowSocketData {
  /** Resolves to the admitted user id, or null for a refused handshake. */
  admission?: Promise<string | null>;
  userId?: string;
  /** Epoch seconds the current credential expires at. */
  exp?: number;
  /** The refresh-token family of the current credential, so a signed-out device can be found. */
  familyId?: string;
  expiryTimer?: NodeJS.Timeout;
  /** Set when an attach starts; cleared again when that attach is refused. */
  sessionId?: string;
  /** Set once an attach succeeds. */
  role?: QuizshowAttachRole;
  /** The player row this socket counts for; null until it joins. */
  playerId?: string | null;
  /**
   * A paired TV's socket, admitted with a screen ticket and no explicit
   * `auth.token` (contract 4.4, 13). `userId` stays undefined on it, and the ticket's claims
   * bind it to the screen role of this one session.
   */
  device?: {
    pairingId: string;
    sessionId: string;
    kind: 'screen';
  };
  /** The pairing of a member socket attached as a helper remote; set once that attach succeeds. */
  helperPairingId?: string;
  /** Epoch seconds the helper ticket expires at: a ceiling on the helper's host rights. */
  helperTicketExp?: number;
  /** Round trips of the last `time:probe` frames, newest last (contract 6.3). */
  rttSamples?: number[];
  /** Sends `time:probe` every `latencyProbeIntervalMs` while a player socket is attached. */
  latencyProbeTimer?: NodeJS.Timeout;
}

type QuizshowSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  QuizshowSocketData
>;

/** A paired TV's socket has no member credential to renew, so its reauth acks `quizshow_wrong_role` (contract 4.4). */
export type QuizshowReauthAck =
  | { ok: true; exp: number }
  | { ok: false; code: ChatWsErrorCode }
  | QuizshowAckFailure;

export interface QuizshowAttachSuccess {
  role: QuizshowAttachRole;
  connectionExpiresAt: number;
}

interface QuizshowFrameContext {
  userId: string;
  sessionId: string;
  playerId: string | null;
}

type QuizshowFrameCheck =
  | { context: QuizshowFrameContext; failure: null }
  | { context: null; failure: QuizshowAckFailure };

type QuizshowStateLookup =
  | { state: QuizshowLiveState; refusal: null }
  | { state: null; refusal: QuizshowErrorCode };

interface QuizshowHostFrameContext {
  userId: string;
  sessionId: string;
  state: QuizshowLiveState;
}

type QuizshowHostFrameCheck =
  | { context: QuizshowHostFrameContext; failure: null }
  | { context: null; failure: QuizshowAckFailure };

/** Every host command acks `isNoop`; `host:createTeams` adds `teamIds`. */
type QuizshowHostCommand<
  Success extends { isNoop: boolean } = { isNoop: boolean },
> = (
  state: QuizshowLiveState,
  now: number,
  userId: string,
) => QuizshowCommandOutcome<Success>;

/** `session:ping` ack (contract 6.6): the server clock and the live phase id, null when unattached. */
export interface QuizshowSessionPingAck {
  ok: true;
  serverNow: number;
  phaseId: string | null;
}

type QuizshowPlayerCommand<Success extends object> = (
  state: QuizshowLiveState,
  playerId: string,
  now: number,
) => QuizshowCommandOutcome<Success>;

/**
 * Same origin allowlist as the chat and desk handshakes: CORS never runs on a
 * raw WebSocket upgrade. A missing `Origin` is a non-browser client and is
 * allowed, as on `/chat`.
 */
function allowQuizshowHandshakeOrigin(
  request: { headers: Record<string, string | string[] | undefined> },
  callback: (error: string | null, isAllowed: boolean) => void,
): void {
  const rawOrigin = request.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin) {
    callback(null, true);
    return;
  }
  callback(null, resolveAllowedOrigins().includes(origin));
}

/** The engine's answer union from the validated frame; null when the fields of its type are missing. */
function toAnswerPayload(
  payload: QuizshowAnswerPayloadDto,
): QuizshowAnswerPayload | null {
  switch (payload.type) {
    case 'multiple_choice':
      return payload.optionIndex === undefined
        ? null
        : { type: 'multiple_choice', optionIndex: payload.optionIndex };
    case 'true_false':
      return payload.isTrue === undefined
        ? null
        : { type: 'true_false', isTrue: payload.isTrue };
    case 'type_answer':
      return payload.text === undefined
        ? null
        : { type: 'type_answer', text: payload.text };
    case 'prompt':
      return payload.text === undefined
        ? null
        : { type: 'prompt', text: payload.text };
    case 'order':
      return payload.orderedIds === undefined
        ? null
        : { type: 'order', orderedIds: [...payload.orderedIds] };
    case 'closest_number':
      return payload.value === undefined
        ? null
        : { type: 'closest_number', value: payload.value };
    default:
      return null;
  }
}

function toTeamChoice(
  team: QuizshowLobbyTeamChoiceDto | null,
): QuizshowJoinTeamChoice {
  if (team === null) return null;
  if (team.teamId !== undefined) return { teamId: team.teamId };
  if (team.newTeam !== undefined) {
    return {
      newTeam: { name: team.newTeam.name, colorKey: team.newTeam.colorKey },
    };
  }
  return null;
}

/**
 * The engine's new key from the validated frame. The DTO's `ValidateIf`
 * rules make each type carry its own field, so the fallbacks only narrow the
 * optional DTO fields for the compiler.
 */
function toCorrectAnswerChange(
  answer: QuizshowCorrectAnswerChangeDto,
): QuizshowChoiceAnswerChange {
  return answer.type === 'multiple_choice'
    ? {
        type: 'multiple_choice',
        correctIndexes: [...(answer.correctIndexes ?? [])],
      }
    : { type: 'true_false', isTrue: answer.isTrue === true };
}

/** The player row of the member in this session, removed or not. */
function livePlayerOf(
  state: QuizshowLiveState,
  userId: string,
): QuizshowLivePlayer | null {
  for (const player of state.players.values()) {
    if (player.userId === userId) return player;
  }
  return null;
}

/**
 * A member with an active player row (neither removed nor left) is playing
 * this session: an organiser is then a co-host playing, and a helper cannot
 * help. A co-host who left the game may run it again.
 */
function isPlayingInSession(state: QuizshowLiveState, userId: string): boolean {
  const player = livePlayerOf(state, userId);
  return player !== null && isActivePlayer(player);
}

/**
 * The unrevoked pairing a ticket names, or null once a host unpaired it. The
 * kind must match the ticket's, and a helper pairing must still belong to
 * the member, so a ticket can never stand in for another device.
 */
function livePairingOf(
  state: QuizshowLiveState,
  pairingId: string,
  expected: { kind: 'screen' } | { kind: 'helper'; userId: string },
): QuizshowLivePairedDevice | null {
  const device = state.pairedDevices.find(
    (pairedDevice) => pairedDevice.pairingId === pairingId,
  );
  if (device === undefined || device.revokedAt !== null) return null;
  if (device.kind !== expected.kind) return null;
  if (expected.kind === 'helper' && device.helperUserId !== expected.userId) {
    return null;
  }
  return device;
}

/** The first name of the profile as a starting screen name; blank when it holds a blocked term. */
function suggestedScreenNameOf(
  profile: Pick<Profile, 'firstName'> | null,
): string {
  return quizshowScreenNameFromFirstName(profile?.firstName);
}

@WebSocketGateway({
  namespace: '/quizshow',
  allowRequest: allowQuizshowHandshakeOrigin,
  cors: {
    origin: (
      _origin: string | undefined,
      callback: (
        error: Error | null,
        allow?: boolean | string | string[],
      ) => void,
    ) => callback(null, resolveFrontendOrigins()),
    credentials: true,
  },
  transports: ['websocket'],
})
@UseFilters(new WsAllExceptionsFilter())
@UsePipes(
  new ValidationPipe({
    ...VALIDATION_PIPE_OPTIONS,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new WsException(errors),
  }),
)
export class QuizshowGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer() namespace!: Namespace;
  private readonly logger = new Logger(QuizshowGateway.name);
  private bucketSweepTimer: NodeJS.Timeout | null = null;
  private readonly handshakeLimiter = new TokenBucketLimiter(
    HANDSHAKE_RATE_LIMIT,
  );
  private readonly reauthLimiter = new TokenBucketLimiter(REAUTH_RATE_LIMIT);
  private readonly attachLimiter = new TokenBucketLimiter(ATTACH_RATE_LIMIT);
  private readonly playerSettingsLimiter = new TokenBucketLimiter(
    PLAYER_SETTINGS_RATE_LIMIT,
  );
  private readonly submissionLimiter = new TokenBucketLimiter(
    SUBMISSION_RATE_LIMIT,
  );
  private readonly hostLimiter = new TokenBucketLimiter(HOST_RATE_LIMIT);
  private readonly timePingLimiter = new TokenBucketLimiter(
    TIME_PING_RATE_LIMIT,
  );
  private readonly reactionLimiter = new TokenBucketLimiter(
    REACTION_RATE_LIMIT,
  );

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly runtime: QuizshowRuntimeService,
    private readonly access: QuizshowAccessService,
    private readonly eventsService: EventsService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(QuizshowSessionRecord)
    private readonly sessions: Repository<QuizshowSessionRecord>,
    private readonly platformSettings: PlatformSettingsService,
    private readonly featureAccess: FeatureAccessService,
    private readonly sessionsService: QuizshowSessionsService,
    private readonly pairingService: QuizshowDevicePairingService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  afterInit(namespace: Namespace): void {
    this.runtime.bindNamespace(namespace);
  }

  onModuleInit(): void {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const limiter of this.allLimiters()) limiter.sweepIdle(now);
    }, BUCKET_SWEEP_INTERVAL_MS);
    timer.unref?.();
    this.bucketSweepTimer = timer;
  }

  onModuleDestroy(): void {
    if (this.bucketSweepTimer) {
      clearInterval(this.bucketSweepTimer);
      this.bucketSweepTimer = null;
    }
  }

  /**
   * Stores the admission promise on the socket before the first await: Nest
   * binds the message handlers right after this starts, so a frame sent on
   * `connect` waits for the verdict.
   */
  async handleConnection(client: QuizshowSocket): Promise<void> {
    client.data.admission = this.admit(client);
    await client.data.admission;
  }

  handleDisconnect(client: QuizshowSocket): void {
    if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
    if (client.data.latencyProbeTimer) {
      clearInterval(client.data.latencyProbeTimer);
      client.data.latencyProbeTimer = undefined;
    }
    this.attachLimiter.clear(client.id);
    this.timePingLimiter.clear(client.id);
    const { sessionId, role, playerId } = client.data;
    if (sessionId !== undefined && role === 'player') {
      this.runtime.noteSocketDetached(sessionId, playerId ?? null);
    }
    // Only an attach that succeeded counted the socket, and only it set the role.
    const devicePairingId =
      client.data.device?.pairingId ?? client.data.helperPairingId;
    if (
      sessionId !== undefined &&
      devicePairingId !== undefined &&
      (role === 'screen' || role === 'host')
    ) {
      this.runtime.noteDeviceSocketDetached(sessionId, devicePairingId);
    }
  }

  /** Lockdown drops every Pulse Live socket; the handshake decides who comes back. */
  @OnEvent(PLATFORM_LOCKDOWN_ENABLED)
  handleLockdownEnabled(): void {
    this.logger.warn('Lockdown enabled: disconnecting Pulse Live sockets');
    this.namespace?.disconnectSockets(true);
  }

  /**
   * As `ChatGateway.handleSessionRevoked`: a signed-out device (a family id)
   * gets `SESSION_REVOKED` and is dropped; every other revocation drops all
   * of the member's sockets with no frame and lets the handshake decide.
   */
  @OnEvent(USER_SESSION_REVOKED)
  handleSessionRevoked(payload: UserSessionRevokedEvent): void {
    const frame = buildChatWsErrorFrame(
      'SESSION_REVOKED',
      'This device was signed out',
    );
    for (const socket of [...(this.namespace?.sockets.values() ?? [])]) {
      const memberSocket = socket as QuizshowSocket;
      if (memberSocket.data.userId !== payload.userId) continue;
      if (!payload.sessionId) {
        memberSocket.disconnect(true);
      } else if (memberSocket.data.familyId === payload.sessionId) {
        memberSocket.emit('exception', frame);
        memberSocket.disconnect(true);
      } else if (memberSocket.data.familyId === undefined) {
        memberSocket.disconnect(true);
      }
    }
  }

  @SubscribeMessage('session:reauth')
  async handleReauth(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowReauthPayload,
  ): Promise<QuizshowReauthAck> {
    const deviceRefusal = await this.deviceSocketRefusal(
      client,
      'session:reauth',
    );
    if (deviceRefusal !== null) return deviceRefusal;
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null) return { ok: false, code: 'UNAUTHORIZED' };
    if (!this.reauthLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    // A helper socket lives no longer than its ticket: a fresh member token
    // cannot carry it past the ticket's `exp`.
    const { helperTicketExp } = client.data;
    if (helperTicketExp !== undefined && Date.now() >= helperTicketExp * 1000) {
      const refusal = this.refusal(
        'session:reauth',
        client,
        'quizshow_device_ticket_expired',
      );
      this.dropForExpiredCredential(client);
      return refusal;
    }
    let exp: number;
    let familyId: string | undefined;
    try {
      const record = socketTicketService.redeem(payload.ticket, userId);
      if (record === null || record.userId !== userId) {
        throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
      }
      if (record.status !== UserStatus.Active) {
        throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
      }
      const user = await this.loadAdmittableUser(userId);
      // Hosting is grant-gated; a player socket is never checked for the
      // grant, and neither is a helper, whose grant is the owner's pairing.
      if (
        (client.data.role === 'screen' || client.data.role === 'host') &&
        client.data.helperPairingId === undefined
      ) {
        await this.assertFeatureOpenTo(user.id);
      }
      await this.assertNotLockedOut(user.role);
      await this.assertSessionLive(record.sessionId);
      exp = record.exp;
      familyId = record.sessionId;
    } catch (error: unknown) {
      const code: ChatWsErrorCode =
        error instanceof ChatWsException ? error.code : 'SERVER_ERROR';
      this.logger.debug(`Pulse Live session:reauth refused: ${code}`);
      this.dropForExpiredCredential(client);
      return { ok: false, code };
    }
    // The socket may have gone while the checks above awaited; a dead socket arms no timer.
    if (!client.connected) return { ok: false, code: 'TOKEN_EXPIRED' };
    if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
    client.data.exp = exp;
    client.data.familyId = familyId;
    // A helper is dropped at its ticket's `exp` when that comes first, so the
    // ack reports that limit, and a passed ticket names itself.
    const connectionCeiling = this.connectionCeilingOf(client);
    if (!this.scheduleTokenExpiry(client, connectionCeiling)) {
      const isTicketCeiling =
        client.data.helperTicketExp !== undefined &&
        connectionCeiling === client.data.helperTicketExp;
      return isTicketCeiling
        ? this.refusal(
            'session:reauth',
            client,
            'quizshow_device_ticket_expired',
          )
        : { ok: false, code: 'TOKEN_EXPIRED' };
    }
    return { ok: true, exp: connectionCeiling };
  }

  @SubscribeMessage('time:ping')
  async handleTimePing(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowTimePingPayload,
  ): Promise<void> {
    const serverReceivedAt = Date.now();
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    // A paired TV's socket syncs its clock too (contract 4.4).
    if (userId === null && client.data.device === undefined) return;
    if (!this.timePingLimiter.tryConsume(client.id)) return;
    client.emit('time:pong', {
      clientSentAt: payload.clientSentAt,
      serverReceivedAt,
      serverSentAt: Date.now(),
    });
  }

  /**
   * Any socket, attached or not (contract 6.6). An unadmitted socket gets no
   * ack, which the client reads as its signal to reconnect; Nest sends no ack
   * for an undefined result.
   */
  @SubscribeMessage('session:ping')
  async handleSessionPing(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() _payload: QuizshowSessionPingPayload,
  ): Promise<QuizshowSessionPingAck | undefined> {
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null && client.data.device === undefined) return undefined;
    const { sessionId, role } = client.data;
    // Memory only: a ping never loads a session from the database. A state
    // that is gone answers a null phase id, and the client resyncs.
    const state =
      sessionId !== undefined && role !== undefined
        ? this.runtime.peekLiveState(sessionId)
        : null;
    return {
      ok: true,
      serverNow: Date.now(),
      phaseId: state?.cursor.phaseId ?? null,
    };
  }

  @SubscribeMessage('quizshow:attach')
  async handleAttach(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAttachPayload,
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null && client.data.device === undefined) {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    if (!this.attachLimiter.tryConsume(client.id)) {
      return this.refusal(frame, client, 'quizshow_rate_limited');
    }
    if (client.data.sessionId !== undefined) {
      return this.refusal(frame, client, 'quizshow_already_attached');
    }
    // Claimed in the same synchronous segment as the check above, so two
    // attach frames in a burst cannot both pass it.
    client.data.sessionId = payload.sessionId;
    client.data.playerId = null;
    let ack: QuizshowAck<QuizshowAttachSuccess>;
    try {
      ack = await this.routeAttach(client, userId, payload);
    } catch (error: unknown) {
      this.releaseAttachClaim(client);
      throw error;
    }
    if (!ack.ok) this.releaseAttachClaim(client);
    return ack;
  }

  @SubscribeMessage('lobby:join')
  async handleLobbyJoin(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowLobbyJoinPayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe }>> {
    const frame = 'lobby:join';
    const check = await this.playerFrameCheck(client, frame, false);
    if (check.failure !== null) return check.failure;
    const { userId, sessionId } = check.context;
    if (!this.playerSettingsLimiter.tryConsume(userId)) {
      return this.refusal(frame, client, 'quizshow_rate_limited');
    }
    const state = await this.runtime.getOrLoad(sessionId);
    if (state === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    const existingPlayer = livePlayerOf(state, userId);
    // A player who left comes back through the engine's rejoin (contract 6.14).
    if (existingPlayer !== null && existingPlayer.leftAt === null) {
      if (existingPlayer.removedAt !== null) {
        return this.refusal(frame, client, 'quizshow_player_removed');
      }
      await this.bindPlayerSockets(
        client,
        userId,
        sessionId,
        existingPlayer.playerId,
      );
      return { ok: true, me: toMe(state, existingPlayer.playerId) };
    }
    const scope = await this.access.loadPlayScope(state);
    if (scope === null) {
      return this.refusal(frame, client, 'quizshow_session_not_found');
    }
    const isRestricted = await this.access.isRestricted(userId);
    let isCohostPlayer: boolean;
    try {
      const mayPlay = await this.access.assertMayPlay({
        session: this.sessionAccessOf(state),
        scope,
        userId,
        isRestricted,
        // A returning row counts its seats in the engine, which skips left players.
        shouldCheckCapacity: existingPlayer === null,
      });
      isCohostPlayer = mayPlay.isCohost;
    } catch (error: unknown) {
      return this.refusalFromError(frame, client, error);
    }
    // Asked on a first join and on a rejoin after a leave: a lobby refresh
    // may have made the session 18+ since the row first joined. A bound
    // rejoin returned above.
    if (state.isAdultsOnly && payload.hasAcceptedAdultContent !== true) {
      return this.refusal(frame, client, 'quizshow_adult_consent_required');
    }
    const profile = await this.loadProfile(userId);
    const outcome = await this.runtime.execute(sessionId, (liveState, now) =>
      // Checked again on the current state: an attach as host or screen may
      // have landed while the checks above awaited.
      this.isRunningSession(liveState, userId)
        ? refuse<{ me: QuizshowMe }>(
            'quizshow_organiser_running',
            liveState,
            false,
          )
        : joinLobby(
            liveState,
            {
              userId,
              isCohostPlayer,
              avatarUrl: toVisibleAvatarUrl(profile),
              screenName: payload.screenName,
              isAvatarShown: payload.isAvatarShown,
              hasExtraTime: payload.hasExtraTime,
              team: toTeamChoice(payload.team),
            },
            now,
            this.runtime.random,
          ),
    );
    if (outcome === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    if (!outcome.ok) return this.engineRefusal(frame, client, outcome.failure);
    // REST reads (the quiz GET, the recap) must find the row once the ack lands.
    await this.runtime.flushWrites(sessionId);
    const { me } = outcome.success;
    await this.bindPlayerSockets(client, userId, sessionId, me.playerId);
    const suggestedScreenName = suggestedScreenNameOf(profile);
    this.emitOnNextTick(sessionId, () => {
      this.namespace?.to(quizshowPlayerRoomName(sessionId, me.playerId)).emit(
        'session:state',
        buildSessionState(state, {
          role: 'player',
          playerId: me.playerId,
          suggestedScreenName,
        }),
      );
    });
    return { ok: true, me };
  }

  @SubscribeMessage('lobby:setName')
  handleSetName(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowSetNamePayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe }>> {
    return this.runPlayerCommand(
      client,
      'lobby:setName',
      'settings',
      (state, playerId, now) =>
        setScreenName(state, playerId, payload.screenName, now),
    );
  }

  @SubscribeMessage('lobby:pickTeam')
  handlePickTeam(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPickTeamPayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe }>> {
    return this.runPlayerCommand(
      client,
      'lobby:pickTeam',
      'settings',
      (state, playerId, now) => pickTeam(state, playerId, payload.teamId, now),
    );
  }

  @SubscribeMessage('lobby:createTeam')
  handleCreateTeam(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowCreateTeamPayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe; teamId: string }>> {
    return this.runPlayerCommand(
      client,
      'lobby:createTeam',
      'settings',
      (state, playerId, now) =>
        createTeam(
          state,
          playerId,
          { name: payload.name, colorKey: payload.colorKey },
          now,
          this.runtime.random,
        ),
    );
  }

  @SubscribeMessage('settings:extraTime')
  handleExtraTime(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowExtraTimePayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe }>> {
    return this.runPlayerCommand(
      client,
      'settings:extraTime',
      'settings',
      (state, playerId, now) =>
        setExtraTime(state, playerId, payload.hasExtraTime, now),
    );
  }

  @SubscribeMessage('settings:avatar')
  handleAvatar(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAvatarPayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe }>> {
    return this.runPlayerCommand(
      client,
      'settings:avatar',
      'settings',
      (state, playerId, now) =>
        setAvatarShown(state, playerId, payload.isAvatarShown, now),
    );
  }

  @SubscribeMessage('joker:play')
  handleJoker(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowJokerPayload,
  ): Promise<QuizshowAck<{ me: QuizshowMe }>> {
    return this.runPlayerCommand(
      client,
      'joker:play',
      'settings',
      (state, playerId, now) =>
        playJoker(state, playerId, payload.roundIndex, now),
    );
  }

  @SubscribeMessage('answer:submit')
  handleAnswerSubmit(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAnswerSubmitPayload,
  ): Promise<QuizshowAck<{ answer: QuizshowMyAnswer; isDuplicate: boolean }>> {
    const answerPayload = toAnswerPayload(payload.payload);
    // This socket's own measured round trips (contract 6.3); nothing the client reports counts.
    const allowanceMs = latencyAllowanceMs(client.data.rttSamples ?? []);
    return this.runPlayerCommand(
      client,
      'answer:submit',
      'submission',
      (state, playerId, now) =>
        answerPayload === null
          ? refuse<{ answer: QuizshowMyAnswer; isDuplicate: boolean }>(
              'quizshow_invalid_answer',
              state,
              false,
            )
          : submitAnswer(
              state,
              playerId,
              {
                phaseId: payload.phaseId,
                questionId: payload.questionId,
                payload: answerPayload,
                latencyAllowanceMs: allowanceMs,
              },
              now,
              this.runtime.random,
            ),
      { isSubmission: true },
    );
  }

  @SubscribeMessage('vote:submit')
  handleVoteSubmit(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowVoteSubmitPayload,
  ): Promise<QuizshowAck<{ vote: QuizshowMyVote; isDuplicate: boolean }>> {
    return this.runPlayerCommand(
      client,
      'vote:submit',
      'submission',
      (state, playerId, now) =>
        submitVote(
          state,
          playerId,
          {
            phaseId: payload.phaseId,
            questionId: payload.questionId,
            optionId: payload.optionId,
          },
          now,
        ),
      { isSubmission: true },
    );
  }

  /** The runtime unbinds the player's sockets on the `player_left` effect (contract 6.14). */
  @SubscribeMessage('lobby:leave')
  handleLobbyLeave(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() _payload: QuizshowLeavePayload,
  ): Promise<QuizshowAck> {
    return this.runPlayerCommand(
      client,
      'lobby:leave',
      'settings',
      (state, playerId, now) =>
        leaveLobby(state, playerId, now, this.runtime.random),
    );
  }

  /** Anonymous (contract 6.19): its own bucket per player, and no log line names the player. */
  @SubscribeMessage('reaction:send')
  async handleReactionSend(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowReactionPayload,
  ): Promise<QuizshowAck> {
    const frame = 'reaction:send';
    const check = await this.playerFrameCheck(client, frame, true);
    if (check.failure !== null) return check.failure;
    const { sessionId, playerId } = check.context;
    if (playerId === null) {
      return this.refusal(frame, client, 'quizshow_not_joined');
    }
    if (!this.reactionLimiter.tryConsume(playerId)) {
      return this.refusal(frame, client, 'quizshow_rate_limited');
    }
    const outcome = await this.runtime.execute(sessionId, (state, now) =>
      sendReaction(state, playerId, payload.reactionId, now),
    );
    return this.toAck(frame, client, outcome);
  }

  @SubscribeMessage('host:start')
  handleHostStart(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:start', (state, now) =>
      hostStart(state, payload.phaseId, now),
    );
  }

  @SubscribeMessage('host:next')
  handleHostNext(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:next', (state, now) =>
      hostNext(state, payload.phaseId, now, this.runtime.random),
    );
  }

  @SubscribeMessage('host:spin')
  handleHostSpin(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:spin', (state, now) =>
      hostSpin(state, payload.phaseId, now, this.runtime.random),
    );
  }

  @SubscribeMessage('host:finishWheel')
  handleHostFinishWheel(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:finishWheel', (state, now) =>
      hostFinishWheel(state, payload.phaseId, now),
    );
  }

  @SubscribeMessage('host:pause')
  handleHostPause(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:pause', (state, now) =>
      hostPause(state, payload.phaseId, now),
    );
  }

  @SubscribeMessage('host:resume')
  handleHostResume(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:resume', (state, now) =>
      hostResume(state, payload.phaseId, now),
    );
  }

  @SubscribeMessage('host:addTime')
  handleHostAddTime(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAddTimePayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:addTime', (state, now) =>
      hostAddTime(
        state,
        {
          phaseId: payload.phaseId,
          seconds: payload.seconds,
          expectedDeadline: payload.expectedDeadline,
        },
        now,
      ),
    );
  }

  @SubscribeMessage('host:reveal')
  handleHostReveal(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:reveal', (state, now) =>
      hostReveal(state, payload.phaseId, now, this.runtime.random),
    );
  }

  @SubscribeMessage('host:skip')
  handleHostSkip(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:skip', (state, now) =>
      hostSkip(state, payload.phaseId, now),
    );
  }

  @SubscribeMessage('host:showAnswers')
  handleHostShowAnswers(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:showAnswers', (state, now) =>
      hostShowAnswers(state, payload.phaseId, now, this.runtime.random),
    );
  }

  @SubscribeMessage('host:hideAnswer')
  handleHostHideAnswer(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowHideAnswerPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(
      client,
      'host:hideAnswer',
      (state, now, userId) =>
        hostHideAnswer(
          state,
          { answerId: payload.answerId, isHidden: payload.isHidden },
          userId,
          now,
        ),
    );
  }

  @SubscribeMessage('host:pickFavourite')
  handleHostPickFavourite(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPickFavouritePayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:pickFavourite', (state, now) =>
      hostPickFavourite(
        state,
        {
          phaseId: payload.phaseId,
          questionId: payload.questionId,
          optionId: payload.optionId,
        },
        now,
      ),
    );
  }

  @SubscribeMessage('host:removePlayer')
  handleHostRemovePlayer(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowRemovePlayerPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(
      client,
      'host:removePlayer',
      (state, now, userId) =>
        hostRemovePlayer(
          state,
          payload.playerId,
          userId,
          now,
          this.runtime.random,
          payload.canRejoin ?? false,
        ),
    );
  }

  @SubscribeMessage('host:renameTeam')
  handleHostRenameTeam(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowRenameTeamPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:renameTeam', (state, now) =>
      hostRenameTeam(
        state,
        { teamId: payload.teamId, name: payload.name },
        now,
      ),
    );
  }

  @SubscribeMessage('host:end')
  handleHostEnd(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPhaseCommandPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:end', (state, now) =>
      hostEnd(state, payload.phaseId, now),
    );
  }

  @SubscribeMessage('host:setScreenMuted')
  async handleHostSetScreenMuted(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowSetScreenMutedPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    const ack = await this.runHostCommand(
      client,
      'host:setScreenMuted',
      (state, now) => hostSetScreenMuted(state, payload.isMuted, now),
    );
    const { sessionId } = client.data;
    if (ack.ok && !ack.isNoop && sessionId !== undefined) {
      for (const room of [
        quizshowRoomName(sessionId, 'screen'),
        quizshowRoomName(sessionId, 'hosts'),
      ]) {
        this.namespace
          ?.to(room)
          .emit('screen:muted', { isMuted: payload.isMuted });
      }
    }
    return ack;
  }

  /** The engine emits `typed:answers` and the rescored `reveal` itself (contract 6.4). */
  @SubscribeMessage('host:acceptAnswer')
  handleHostAcceptAnswer(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAcceptAnswerPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:acceptAnswer', (state, now) =>
      hostAcceptAnswer(
        state,
        {
          phaseId: payload.phaseId,
          questionId: payload.questionId,
          normalisedText: payload.normalisedText,
        },
        now,
      ),
    );
  }

  @SubscribeMessage('host:changeCorrectAnswer')
  handleHostChangeCorrectAnswer(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowChangeCorrectAnswerPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    const answer = toCorrectAnswerChange(payload.answer);
    return this.runHostCommand(
      client,
      'host:changeCorrectAnswer',
      (state, now) =>
        hostChangeCorrectAnswer(
          state,
          { phaseId: payload.phaseId, questionId: payload.questionId, answer },
          now,
        ),
    );
  }

  /** A repeated `requestId` acks as a no-op (contract 4.3). */
  @SubscribeMessage('host:adjustPoints')
  handleHostAdjustPoints(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAdjustPointsPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:adjustPoints', (state, now) =>
      hostAdjustPoints(
        state,
        {
          entrantId: payload.entrantId,
          delta: payload.delta,
          requestId: payload.requestId,
        },
        now,
      ),
    );
  }

  /**
   * Runs the host frame checks, then the sessions service, which owns the
   * contract 6.8 checks and the push; its refusal code is acked as it is.
   * Pushed or refused, the attempt resets the abandonment clock and saves
   * it with a checkpoint, as every other host command does.
   */
  @SubscribeMessage('host:notifyGuests')
  async handleHostNotifyGuests(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() _payload: QuizshowNotifyGuestsPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    const frame = 'host:notifyGuests';
    const check = await this.hostFrameCheck(client, frame);
    if (check.failure !== null) return check.failure;
    const { sessionId } = check.context;
    const refusalCode =
      await this.sessionsService.notifyGuestsForSession(sessionId);
    await this.runtime.execute(sessionId, (state, now) =>
      hostActed(state, now, [], refusalCode !== null),
    );
    if (refusalCode !== null) return this.refusal(frame, client, refusalCode);
    return { ok: true, isNoop: false };
  }

  /** All the names or none; the ack carries the new team ids in payload order. */
  @SubscribeMessage('host:createTeams')
  handleHostCreateTeams(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowCreateTeamsPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean; teamIds: string[] }>> {
    return this.runHostCommand(client, 'host:createTeams', (state, now) =>
      hostCreateTeams(state, [...payload.names], now, this.runtime.random),
    );
  }

  @SubscribeMessage('host:renamePlayer')
  handleHostRenamePlayer(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowRenamePlayerPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:renamePlayer', (state, now) =>
      hostRenamePlayer(state, payload.playerId, payload.screenName, now),
    );
  }

  @SubscribeMessage('host:movePlayer')
  handleHostMovePlayer(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowMovePlayerPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:movePlayer', (state, now) =>
      hostMovePlayer(state, payload.playerId, payload.teamId, now),
    );
  }

  @SubscribeMessage('host:setJoinLock')
  handleHostSetJoinLock(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowSetJoinLockPayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:setJoinLock', (state, now) =>
      hostSetJoinLock(state, payload.isLocked, now),
    );
  }

  @SubscribeMessage('host:setAutoAdvance')
  handleHostSetAutoAdvance(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowSetAutoAdvancePayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    return this.runHostCommand(client, 'host:setAutoAdvance', (state, now) =>
      hostSetAutoAdvance(state, payload.isOn, now),
    );
  }

  /**
   * Pairs a TV or a helper phone by the code it shows (contract 6.5). Open
   * to an organiser host or the game owner; a helper refuses. The lookup's
   * refusal codes pass through as they are. Two frames with one code can
   * both pass the lookup; only the first to reach the live state adds the
   * device, and the other acks `quizshow_pairing_code_used`. When the pending
   * entry is gone by the time the ticket is ready, the device this frame
   * added is unpaired at once, so every live pairing has a ticket on its way
   * to its device.
   */
  @SubscribeMessage('host:pairDevice')
  async handleHostPairDevice(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowPairDevicePayload,
  ): Promise<QuizshowAck<{ isNoop: boolean; device: QuizshowPairedDevice }>> {
    const frame = 'host:pairDevice';
    const check = await this.hostFrameCheck(client, frame);
    if (check.failure !== null) return check.failure;
    if (client.data.helperPairingId !== undefined) {
      return this.refusal(frame, client, 'quizshow_helper_cannot_pair');
    }
    const { userId, sessionId, state } = check.context;
    const lookup = this.pairingService.findPendingByCode(
      payload.pairingCode,
      userId,
    );
    if (!lookup.ok) return this.refusal(frame, client, lookup.code);
    const { pairingId, kind, starterUserId } = lookup.pairing;
    let helperUserId: string | null = null;
    if (kind === 'helper') {
      // A helper code always names the member who asked for it.
      if (starterUserId === null) {
        return this.refusal(frame, client, 'quizshow_pairing_code_not_found');
      }
      if (isPlayingInSession(state, starterUserId)) {
        return this.refusal(frame, client, 'quizshow_helper_is_playing');
      }
      // The helper must be someone who may see this session's scope. A
      // block either way between the helper and the host reads as a hidden
      // event, so the pairing host never learns of a block.
      const scopeRefusal = await this.helperScopeRefusal(state, starterUserId, {
        hiddenEvent: 'quizshow_cannot_view_event',
        blocked: 'quizshow_cannot_view_event',
      });
      if (scopeRefusal !== null) {
        return this.refusal(frame, client, scopeRefusal);
      }
      helperUserId = starterUserId;
    }
    // The rule a reload reads too (`loadHelperNames`), so the name holds
    // across a restart.
    const helperName =
      helperUserId === null
        ? null
        : quizshowHelperNameFromFirstName(
            (await this.loadProfile(helperUserId))?.firstName,
          );
    // When the entry this frame pushed was paired, so a later revoke can
    // only ever touch it, even in a live state reloaded in between.
    const pushed: { pairedAt: number | null } = { pairedAt: null };
    const outcome = await this.runtime.execute(sessionId, (liveState, now) => {
      // Checked again on the current state: the session may have ended, or
      // the helper joined as a player, while the checks above awaited.
      if (!OPEN_STATUSES.has(liveState.status)) {
        return refuse<{ isNoop: boolean; device: QuizshowPairedDevice }>(
          statusRefusalCode(liveState.status, 'open'),
          liveState,
          false,
        );
      }
      if (
        helperUserId !== null &&
        isPlayingInSession(liveState, helperUserId)
      ) {
        return refuse<{ isNoop: boolean; device: QuizshowPairedDevice }>(
          'quizshow_helper_is_playing',
          liveState,
          false,
        );
      }
      // Another frame with the same code got here first.
      if (
        liveState.pairedDevices.some(
          (pairedDevice) => pairedDevice.pairingId === pairingId,
        )
      ) {
        return refuse<{ isNoop: boolean; device: QuizshowPairedDevice }>(
          'quizshow_pairing_code_used',
          liveState,
          false,
        );
      }
      const added = hostAddPairedDevice(
        liveState,
        {
          pairingId,
          kind,
          helperUserId,
          helperName,
          pairedAt: now,
          revokedAt: null,
          connectedSocketCount: 0,
        },
        now,
      );
      if (added.ok) pushed.pairedAt = now;
      return added;
    });
    if (outcome === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    if (!outcome.ok) return this.engineRefusal(frame, client, outcome.failure);
    const deviceTicket = this.pairingService.mintDeviceTicket({
      sessionId,
      pairingId,
      kind,
      helperUserId,
    });
    const isPaired = this.pairingService.completePairing(
      pairingId,
      sessionId,
      deviceTicket,
      { kind: state.kind, eventSlug: state.eventSlug, gameId: state.gameId },
    );
    if (!isPaired) {
      const orphanPairedAt = pushed.pairedAt;
      await this.runtime.execute(sessionId, (liveState, now) =>
        // Only the entry this frame pushed (its pairing id and paired time),
        // and only while it is live.
        liveState.pairedDevices.some(
          (pairedDevice) =>
            pairedDevice.pairingId === pairingId &&
            pairedDevice.pairedAt === orphanPairedAt &&
            pairedDevice.revokedAt === null,
        )
          ? hostRevokePairedDevice(liveState, pairingId, now)
          : refuse<{ isNoop: boolean }>(
              'quizshow_device_not_found',
              liveState,
              false,
            ),
      );
      return this.refusal(frame, client, 'quizshow_pairing_code_used');
    }
    return this.toAck(frame, client, outcome);
  }

  /**
   * Unpairs a TV or a helper (contract 6.5); a helper refuses. Every socket
   * holding that pairing gets `device:unpaired` and is dropped at once, so
   * its ticket stops working; `devices:update` comes from the engine.
   */
  @SubscribeMessage('host:unpairDevice')
  async handleHostUnpairDevice(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowUnpairDevicePayload,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    const frame = 'host:unpairDevice';
    const check = await this.hostFrameCheck(client, frame);
    if (check.failure !== null) return check.failure;
    if (client.data.helperPairingId !== undefined) {
      return this.refusal(frame, client, 'quizshow_helper_cannot_pair');
    }
    const { sessionId } = check.context;
    const outcome = await this.runtime.execute(sessionId, (liveState, now) =>
      hostRevokePairedDevice(liveState, payload.pairingId, now),
    );
    const ack = this.toAck(frame, client, outcome);
    if (ack.ok) this.dropPairedDeviceSockets(sessionId, payload.pairingId);
    return ack;
  }

  private async admit(client: QuizshowSocket): Promise<string | null> {
    // Closed to everyone, so refused before any token or database work. In
    // early access every active member is admitted to play; hosting checks
    // the grant at attach.
    if (!isQuizshowPlayable()) {
      this.refuseHandshake(
        client,
        buildChatWsErrorFrame('NOT_FOUND', FEATURE_HIDDEN_MESSAGE),
      );
      return null;
    }
    // An explicit `auth.token` takes the member path. Otherwise a non-empty
    // ticket admits a screen before the cookie is read, so a TV browser that also
    // holds a member cookie still comes in as the paired screen (contract 13).
    const handshakeAuth = client.handshake.auth as
      { token?: unknown; deviceTicket?: unknown } | undefined;
    const hasExplicitToken =
      typeof handshakeAuth?.token === 'string' && handshakeAuth.token !== '';
    const deviceTicket = handshakeAuth?.deviceTicket;
    if (
      !hasExplicitToken &&
      typeof deviceTicket === 'string' &&
      deviceTicket !== ''
    ) {
      return this.admitScreenDevice(client, deviceTicket);
    }
    try {
      const claims = await this.verifyHandshakeToken(client);
      // Metered on the verified user id, before any database read.
      if (!this.handshakeLimiter.tryConsume(claims.sub)) {
        throw new ChatWsException(
          'RATE_LIMITED',
          'You are reconnecting too quickly',
        );
      }
      const user = await this.loadAdmittableUser(claims.sub);
      await this.assertNotLockedOut(user.role);
      await this.assertSessionLive(claims.sid);
      // The client may have gone while the checks above awaited.
      if (!client.connected) return null;
      client.data.userId = user.id;
      client.data.exp = claims.exp;
      client.data.familyId = claims.sid;
      if (!this.scheduleTokenExpiry(client, claims.exp)) {
        client.data.userId = undefined;
        return null;
      }
      return user.id;
    } catch (error: unknown) {
      return this.refuseHandshakeError(client, error);
    }
  }

  /**
   * Admits a paired TV holding a screen ticket (contract 4.4). The handshake
   * checks the signature, `typ` and `exp`; the attach checks the session and
   * the revocation (decision A20). No grant check: a granted host paired this
   * screen. The admission resolves to null, since the socket has no member;
   * `data.device` is what marks it admitted. The ticket never reaches a log.
   */
  private async admitScreenDevice(
    client: QuizshowSocket,
    deviceTicket: string,
  ): Promise<null> {
    try {
      const claims = this.pairingService.verifyDeviceTicket(deviceTicket);
      // A helper ticket rides on a member socket's attach and never admits a socket alone.
      if (claims === null || claims.kind !== 'screen') {
        throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
      }
      if (!this.handshakeLimiter.tryConsume(`device:${claims.pid}`)) {
        throw new ChatWsException(
          'RATE_LIMITED',
          'You are reconnecting too quickly',
        );
      }
      // A screen has no member role, so lockdown holds it to the member rule.
      await this.assertNotLockedOut(UserRole.Member);
      // The client may have gone while the check above awaited.
      if (!client.connected) return null;
      client.data.device = {
        pairingId: claims.pid,
        sessionId: claims.sid,
        kind: 'screen',
      };
      client.data.exp = claims.exp;
      if (!this.scheduleTokenExpiry(client, claims.exp)) {
        client.data.device = undefined;
      }
      return null;
    } catch (error: unknown) {
      return this.refuseHandshakeError(client, error);
    }
  }

  /** Sends the transport refusal a failed handshake earned; anything unexpected reads as `SERVER_ERROR`. */
  private refuseHandshakeError(client: QuizshowSocket, error: unknown): null {
    if (error instanceof ChatWsException) {
      const frame = error.getError() as ChatWsErrorFrame;
      this.logger.debug(`Pulse Live handshake refused: ${frame.code}`);
      this.refuseHandshake(client, frame);
      return null;
    }
    this.logger.error('Pulse Live handshake failed: SERVER_ERROR');
    this.refuseHandshake(
      client,
      buildChatWsErrorFrame('SERVER_ERROR', 'Internal server error'),
    );
    return null;
  }

  private refuseHandshake(
    client: QuizshowSocket,
    frame: ChatWsErrorFrame,
  ): void {
    client.emit('exception', frame);
    client.disconnect(true);
  }

  /** A paired TV attaches with its handshake ticket, a helper with the ticket in the payload, every other socket as today. */
  private routeAttach(
    client: QuizshowSocket,
    userId: string | null,
    payload: QuizshowAttachPayload,
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const { device } = client.data;
    if (device !== undefined) {
      return this.attachScreenDevice(client, device, payload);
    }
    if (userId === null) {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    if (payload.as === 'player') {
      return this.attachPlayer(client, userId, payload.sessionId);
    }
    if (payload.as === 'host' && payload.deviceTicket !== undefined) {
      return this.attachHelper(
        client,
        userId,
        payload.sessionId,
        payload.deviceTicket,
      );
    }
    return this.attachOrganiser(client, userId, payload.sessionId, payload.as);
  }

  /**
   * A paired TV's attach (contract 4.4): only as `screen` and only for its
   * ticket's session. The session must be open and the pairing unrevoked
   * (decision A20). No grant or organiser check: a granted host paired it.
   */
  private async attachScreenDevice(
    client: QuizshowSocket,
    device: NonNullable<QuizshowSocketData['device']>,
    payload: QuizshowAttachPayload,
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    if (payload.as !== 'screen' || payload.sessionId !== device.sessionId) {
      return this.refusal(frame, client, 'quizshow_wrong_role');
    }
    const lookup = await this.loadAttachableState(device.sessionId);
    if (lookup.state === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    const expected = { kind: 'screen' } as const;
    if (livePairingOf(lookup.state, device.pairingId, expected) === null) {
      return this.refusal(frame, client, 'quizshow_device_unpaired');
    }
    return this.joinAsPairedDevice(
      client,
      device.sessionId,
      device.pairingId,
      expected,
    );
  }

  /**
   * A helper remote's attach (contract 4.4): a member socket with `as:
   * 'host'` and a helper ticket. The ticket counts only for the signed-in
   * member it names and the session it names; any mismatch reads as a bad
   * ticket. The owner's pairing stands in for the grant and organiser
   * checks. The member is recorded as an attached organiser, so they cannot
   * join as a player while helping.
   *
   * An unpair leaves the member in `attachedOrganiserUserIds` (accepted in
   * the final review): an organiser who stops running the game stays there
   * too, so everyone who ran the session from a host remote meets one rule
   * and cannot join this session as a player afterwards.
   */
  private async attachHelper(
    client: QuizshowSocket,
    userId: string,
    sessionId: string,
    deviceTicket: string,
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    const claims = this.pairingService.verifyDeviceTicket(deviceTicket);
    if (
      claims === null ||
      claims.kind !== 'helper' ||
      claims.uid !== userId ||
      claims.sid !== sessionId
    ) {
      return this.refusal(frame, client, 'quizshow_device_ticket_expired');
    }
    const pairingId = claims.pid;
    const expected = { kind: 'helper', userId } as const;
    const lookup = await this.loadAttachableState(sessionId);
    if (lookup.state === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    if (livePairingOf(lookup.state, pairingId, expected) === null) {
      return this.refusal(frame, client, 'quizshow_device_unpaired');
    }
    if (isPlayingInSession(lookup.state, userId)) {
      return this.refusal(frame, client, 'quizshow_helper_is_playing');
    }
    const scopeRefusal = await this.helperScopeRefusal(lookup.state, userId, {
      hiddenEvent: 'quizshow_session_not_found',
      blocked: 'quizshow_banned_from_event',
    });
    if (scopeRefusal !== null) {
      return this.refusal(frame, client, scopeRefusal);
    }
    const outcome = await this.runtime.execute(sessionId, (liveState) => {
      // Checked again on the current state: a lobby:join or an unpair may
      // have landed while the checks above awaited.
      if (isPlayingInSession(liveState, userId)) {
        return refuse('quizshow_helper_is_playing', liveState, false);
      }
      if (livePairingOf(liveState, pairingId, expected) === null) {
        return refuse('quizshow_device_unpaired', liveState, false);
      }
      return recordAttachedOrganiser(liveState, userId);
    });
    if (outcome === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    if (!outcome.ok) return this.engineRefusal(frame, client, outcome.failure);
    return this.joinAsPairedDevice(client, sessionId, pairingId, {
      ...expected,
      ticketExp: claims.exp,
    });
  }

  /**
   * The scope checks a helper meets, as an organiser attach and a player
   * join meet theirs: an event they cannot see answers `codes.hiddenEvent`,
   * an event ban answers `quizshow_banned_from_event`, a block either way
   * with the event's host answers `codes.blocked`, and a game answers
   * `codes.blocked` for a member blocked either way with its owner. Null
   * when the helper may help.
   *
   * The helper's own attach learns nothing about a hidden event
   * (`quizshow_session_not_found`) and reads a block as a bar, as a player
   * join does. The pairing host, who sees the session, learns that the
   * helper cannot view the event (`quizshow_cannot_view_event`) for a
   * hidden event and for a block alike, so a pairing never discloses a
   * block between two other members.
   */
  private async helperScopeRefusal(
    state: QuizshowLiveState,
    userId: string,
    codes: {
      hiddenEvent: 'quizshow_session_not_found' | 'quizshow_cannot_view_event';
      blocked: 'quizshow_banned_from_event' | 'quizshow_cannot_view_event';
    },
  ): Promise<QuizshowErrorCode | null> {
    const scope = await this.access.loadPlayScope(state);
    if (scope === null) return 'quizshow_session_not_found';
    if (scope.kind === 'game') {
      const isBlocked = await this.blockFilter.isBlockedEitherWay(
        scope.ownerUserId,
        userId,
      );
      return isBlocked ? codes.blocked : null;
    }
    try {
      await this.eventsService.assertCanView(scope.event, userId);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) return codes.hiddenEvent;
      throw error;
    }
    const barCause = await this.access.eventBarCause(scope.event, userId);
    if (barCause === 'banned') return 'quizshow_banned_from_event';
    if (barCause === 'blocked') return codes.blocked;
    return null;
  }

  /**
   * Joins the device's role room, then checks the pairing once more, since
   * an unpair may land during the join. The role, the pairing and the count
   * are set in one synchronous step after that check, so an unpair either
   * finds this socket and drops it or is found here.
   */
  private async joinAsPairedDevice(
    client: QuizshowSocket,
    sessionId: string,
    pairingId: string,
    expected:
      | { kind: 'screen' }
      | { kind: 'helper'; userId: string; ticketExp: number },
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    if (!client.connected) {
      return this.refusal(frame, client, 'quizshow_not_attached');
    }
    const room = quizshowRoomName(
      sessionId,
      expected.kind === 'screen' ? 'screen' : 'hosts',
    );
    await client.join(room);
    const liveState = this.runtime.peekLiveState(sessionId);
    let refusalCode: QuizshowErrorCode | null = null;
    if (!client.connected) {
      refusalCode = 'quizshow_not_attached';
    } else if (liveState === null || !OPEN_STATUSES.has(liveState.status)) {
      refusalCode = 'quizshow_session_finished';
    } else if (livePairingOf(liveState, pairingId, expected) === null) {
      refusalCode = 'quizshow_device_unpaired';
    }
    if (refusalCode !== null || liveState === null) {
      await client.leave(room);
      return this.refusal(
        frame,
        client,
        refusalCode ?? 'quizshow_session_finished',
      );
    }
    // A helper socket is dropped at its ticket's `exp` when that comes before
    // the member token's, through the same `TOKEN_EXPIRED` drop.
    if (
      expected.kind === 'helper' &&
      expected.ticketExp < (client.data.exp ?? Number.POSITIVE_INFINITY)
    ) {
      if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
      if (!this.scheduleTokenExpiry(client, expected.ticketExp)) {
        await client.leave(room);
        return this.refusal(frame, client, 'quizshow_device_ticket_expired');
      }
    }
    // A paired TV gets exactly what the screen role gets, the event title
    // and slug, the next event and the avatars included (contract 13): the
    // host placed it, so it is the host's own screen.
    const role = expected.kind === 'screen' ? 'screen' : 'host';
    client.data.role = role;
    if (expected.kind === 'helper') {
      client.data.helperPairingId = pairingId;
      client.data.helperTicketExp = expected.ticketExp;
    }
    this.runtime.noteDeviceSocketAttached(sessionId, pairingId);
    this.scheduleSessionState(
      client,
      liveState,
      role === 'screen' ? { role: 'screen' } : { role: 'host' },
    );
    return this.attachSuccess(client, role);
  }

  /**
   * A paired TV's socket may send only `quizshow:attach`, `time:ping` and
   * `session:ping` (contract 4.4); every other frame acks
   * `quizshow_wrong_role`. It waits for the handshake verdict first, since
   * the verdict is what marks a device socket.
   */
  private async deviceSocketRefusal(
    client: QuizshowSocket,
    frame: string,
  ): Promise<QuizshowAckFailure | null> {
    if (client.data.userId === undefined) await client.data.admission;
    if (client.data.device === undefined) return null;
    return this.refusal(frame, client, 'quizshow_wrong_role');
  }

  /**
   * `device:unpaired` to every socket of this session holding the pairing,
   * then the drop (contract 4.1). A screen socket matches from its handshake
   * on, attached or not; a helper socket once its attach succeeded.
   */
  private dropPairedDeviceSockets(sessionId: string, pairingId: string): void {
    for (const socket of [...(this.namespace?.sockets.values() ?? [])]) {
      const deviceSocket = socket as QuizshowSocket;
      const { data } = deviceSocket;
      const isScreenOfPairing =
        data.device?.pairingId === pairingId &&
        data.device.sessionId === sessionId;
      const isHelperOfPairing =
        data.helperPairingId === pairingId && data.sessionId === sessionId;
      if (!isScreenOfPairing && !isHelperOfPairing) continue;
      deviceSocket.emit('device:unpaired', { pairingId });
      deviceSocket.disconnect(true);
    }
  }

  private async attachOrganiser(
    client: QuizshowSocket,
    userId: string,
    sessionId: string,
    role: 'screen' | 'host',
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    // Hosting is grant-gated: a member without the grant learns nothing about the session.
    if (!(await this.featureAccess.canUseFeature('quizshow', userId))) {
      return this.refusal(frame, client, 'quizshow_session_not_found');
    }
    const lookup = await this.loadAttachableState(sessionId);
    if (lookup.state === null) {
      return this.refusal(frame, client, lookup.refusal);
    }
    const state = lookup.state;
    if (state.kind === 'game') {
      // Only the owner runs a game; anyone else gets the not-found refusal.
      if (state.hostUserId === null || state.hostUserId !== userId) {
        return this.refusal(frame, client, 'quizshow_session_not_found');
      }
    } else {
      const refusalCode = await this.eventOrganiserRefusal(state, userId);
      if (refusalCode !== null) {
        return this.refusal(frame, client, refusalCode);
      }
    }
    if (isPlayingInSession(state, userId)) {
      return this.refusal(frame, client, 'quizshow_cohost_is_playing');
    }
    const outcome = await this.runtime.execute(sessionId, (liveState) =>
      // Checked again on the current state: a lobby:join may have landed
      // while the checks above awaited.
      isPlayingInSession(liveState, userId)
        ? refuse('quizshow_cohost_is_playing', liveState, false)
        : recordAttachedOrganiser(liveState, userId),
    );
    if (outcome === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    if (!outcome.ok) return this.engineRefusal(frame, client, outcome.failure);
    if (!client.connected) {
      return this.refusal(frame, client, 'quizshow_not_attached');
    }
    await client.join(
      quizshowRoomName(sessionId, role === 'screen' ? 'screen' : 'hosts'),
    );
    client.data.role = role;
    this.scheduleSessionState(
      client,
      state,
      role === 'screen' ? { role: 'screen' } : { role: 'host' },
    );
    return this.attachSuccess(client, role);
  }

  /**
   * Why a member cannot attach as screen or host to an event session, or
   * null when they organise it: a missing or hidden event is not found, a
   * viewer who does not organise it is not an organiser.
   */
  private async eventOrganiserRefusal(
    state: QuizshowLiveState,
    userId: string,
  ): Promise<QuizshowErrorCode | null> {
    const scope = await this.access.loadPlayScope(state);
    if (scope === null || scope.kind !== 'event') {
      return 'quizshow_session_not_found';
    }
    let isOrganizer: boolean;
    try {
      isOrganizer = await this.eventsService.assertCanView(scope.event, userId);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        return 'quizshow_session_not_found';
      }
      throw error;
    }
    return isOrganizer ? null : 'quizshow_not_organiser';
  }

  private async attachPlayer(
    client: QuizshowSocket,
    userId: string,
    sessionId: string,
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    const lookup = await this.loadAttachableState(sessionId);
    if (lookup.state === null) {
      return this.refusal(frame, client, lookup.refusal);
    }
    const state = lookup.state;
    const scope = await this.access.loadPlayScope(state);
    if (scope === null) {
      return this.refusal(frame, client, 'quizshow_session_not_found');
    }
    const isRestricted = await this.access.isRestricted(userId);
    try {
      await this.access.assertMayPlay({
        session: this.sessionAccessOf(state),
        scope,
        userId,
        isRestricted,
        shouldCheckCapacity: false,
      });
    } catch (error: unknown) {
      return this.refusalFromError(frame, client, error);
    }
    // The live state is ahead of the database: a removal may still be queued.
    const livePlayer = livePlayerOf(state, userId);
    if (livePlayer !== null && livePlayer.removedAt !== null) {
      return this.refusal(frame, client, 'quizshow_player_removed');
    }
    const profile = await this.loadProfile(userId);
    if (!client.connected) {
      return this.refusal(frame, client, 'quizshow_not_attached');
    }
    await client.join(quizshowRoomName(sessionId, 'players'));
    client.data.role = 'player';
    // A player who left stays unbound until a lobby:join brings the row back (contract 6.14).
    if (livePlayer !== null && livePlayer.leftAt === null) {
      await this.bindPlayer(client, sessionId, livePlayer.playerId);
      // An away player gets a place in the question still taking answers
      // (contract 6.2), once the socket really counts for them.
      if (client.connected && client.data.playerId === livePlayer.playerId) {
        await this.runtime.execute(sessionId, (liveState, now) =>
          returnAwayPlayer(liveState, livePlayer.playerId, now),
        );
      }
    }
    this.scheduleSessionState(client, state, {
      role: 'player',
      playerId: client.data.playerId ?? null,
      // A player who left gets the name they played under, ready for a rejoin.
      suggestedScreenName:
        livePlayer !== null && livePlayer.leftAt !== null
          ? livePlayer.screenName
          : suggestedScreenNameOf(profile),
    });
    this.startLatencyProbes(client);
    return this.attachSuccess(client, 'player');
  }

  /**
   * One `time:probe` now and one every `latencyProbeIntervalMs` while the
   * player socket stays (contract 6.3). Synchronous after the connected
   * check, so a disconnect cannot slip between the check and the timer.
   */
  private startLatencyProbes(client: QuizshowSocket): void {
    if (!client.connected) return;
    if (client.data.latencyProbeTimer) {
      clearInterval(client.data.latencyProbeTimer);
    }
    client.data.rttSamples = client.data.rttSamples ?? [];
    this.sendLatencyProbe(client);
    const timer = setInterval(() => {
      if (!this.shouldKeepProbing(client)) {
        clearInterval(timer);
        if (client.data.latencyProbeTimer === timer) {
          client.data.latencyProbeTimer = undefined;
        }
        return;
      }
      this.sendLatencyProbe(client);
    }, QUIZSHOW_LIMITS.latencyProbeIntervalMs);
    timer.unref?.();
    client.data.latencyProbeTimer = timer;
  }

  /**
   * The probes stop once the socket is gone, the session's live state left
   * memory (it ended or was swept) or the socket left the players room (a
   * removal evicts it). The state check reads memory only.
   */
  private shouldKeepProbing(client: QuizshowSocket): boolean {
    const { sessionId } = client.data;
    return (
      client.connected &&
      sessionId !== undefined &&
      this.runtime.peekLiveState(sessionId) !== null &&
      client.rooms.has(quizshowRoomName(sessionId, 'players'))
    );
  }

  /** Records the round trip on the client's ack; a timeout records nothing. */
  private sendLatencyProbe(client: QuizshowSocket): void {
    const sentAt = Date.now();
    client
      .timeout(QUIZSHOW_LIMITS.latencyProbeTimeoutMs)
      .emit('time:probe', { sentAt }, (error: Error | null) => {
        if (error) return;
        client.data.rttSamples = withRttSample(
          client.data.rttSamples ?? [],
          Date.now() - sentAt,
        );
      });
  }

  private attachSuccess(
    client: QuizshowSocket,
    role: QuizshowAttachRole,
  ): QuizshowAck<QuizshowAttachSuccess> {
    return {
      ok: true,
      role,
      connectionExpiresAt: this.connectionCeilingOf(client) * 1000,
    };
  }

  /** Epoch seconds the socket is dropped at: the credential's `exp`, capped by a helper ticket's `exp`. */
  private connectionCeilingOf(client: QuizshowSocket): number {
    const credentialExp = client.data.exp ?? 0;
    const { helperTicketExp } = client.data;
    return helperTicketExp === undefined
      ? credentialExp
      : Math.min(credentialExp, helperTicketExp);
  }

  private releaseAttachClaim(client: QuizshowSocket): void {
    if (client.data.role !== undefined) return;
    client.data.sessionId = undefined;
    client.data.playerId = null;
  }

  /** `session:state` right after the ack the handler is about to return. */
  private scheduleSessionState(
    client: QuizshowSocket,
    state: QuizshowLiveState,
    viewer: QuizshowSessionStateViewer,
  ): void {
    this.emitOnNextTick(state.sessionId, () => {
      if (!client.connected) return;
      this.runtime.emitSessionState(client, state, viewer);
    });
  }

  /** Runs a frame builder on the next tick; a builder that throws logs its code and the session id only. */
  private emitOnNextTick(sessionId: string, emitFrame: () => void): void {
    setImmediate(() => {
      try {
        emitFrame();
      } catch (error: unknown) {
        this.logger.error(
          `Pulse Live session:state frame failed for session ${sessionId}: ${quizshowWriteFailureCode(error)}`,
        );
      }
    });
  }

  /** The socket joins the player's private room and counts as one of their connections. */
  private async bindPlayer(
    client: QuizshowSocket,
    sessionId: string,
    playerId: string,
  ): Promise<void> {
    if (client.data.playerId === playerId || !client.connected) return;
    // Counted before the await, so a disconnect during the join detaches it.
    client.data.playerId = playerId;
    this.runtime.noteSocketAttached(sessionId, playerId);
    const privateRoom = quizshowPlayerRoomName(sessionId, playerId);
    await client.join(privateRoom);
    // A leave or a remove with rejoin may have unbound the socket during the
    // join; the runtime already counted that detach, so only the room goes.
    if (client.data.playerId !== playerId) {
      await client.leave(privateRoom);
    }
  }

  /** Binds the frame's socket, then every other player socket of the member in this session that has no player yet. */
  private async bindPlayerSockets(
    client: QuizshowSocket,
    userId: string,
    sessionId: string,
    playerId: string,
  ): Promise<void> {
    await this.bindPlayer(client, sessionId, playerId);
    for (const socket of [...(this.namespace?.sockets.values() ?? [])]) {
      const memberSocket = socket as QuizshowSocket;
      const { data } = memberSocket;
      if (
        memberSocket === client ||
        data.userId !== userId ||
        data.sessionId !== sessionId ||
        data.role !== 'player' ||
        (data.playerId ?? null) !== null
      ) {
        continue;
      }
      await this.bindPlayer(memberSocket, sessionId, playerId);
    }
  }

  /** The host, the opener and an organiser attached as screen or host run the session and cannot play it. */
  private isRunningSession(state: QuizshowLiveState, userId: string): boolean {
    return (
      state.hostUserId === userId ||
      state.openedByUserId === userId ||
      state.attachedOrganiserUserIds.has(userId)
    );
  }

  /** The live state of an open session, or why an attach cannot have one. */
  private async loadAttachableState(
    sessionId: string,
  ): Promise<QuizshowStateLookup> {
    const state = await this.runtime.getOrLoad(sessionId);
    if (state !== null && OPEN_STATUSES.has(state.status)) {
      return { state, refusal: null };
    }
    if (state !== null) {
      return { state: null, refusal: 'quizshow_session_finished' };
    }
    const storedSession = await this.sessions.findOne({
      where: { id: sessionId },
      select: { id: true, status: true },
    });
    return {
      state: null,
      refusal:
        storedSession === null
          ? 'quizshow_session_not_found'
          : 'quizshow_session_finished',
    };
  }

  /** The session fields `assertMayPlay` reads, from the live state (fresher than the row). */
  private sessionAccessOf(
    state: QuizshowLiveState,
  ): QuizshowMayPlayInput['session'] {
    return {
      id: state.sessionId,
      startedByUserId: state.openedByUserId,
      attachedOrganiserUserIds: [...state.attachedOrganiserUserIds],
    };
  }

  private loadProfile(userId: string): Promise<Profile | null> {
    return this.profiles.findOne({
      where: { userId },
      select: {
        userId: true,
        firstName: true,
        avatarUrl: true,
        photoVisible: true,
      },
    });
  }

  /** Admitted, attached as a player and, when `isJoinRequired`, joined. */
  private async playerFrameCheck(
    client: QuizshowSocket,
    frame: string,
    isJoinRequired: boolean,
  ): Promise<QuizshowFrameCheck> {
    const deviceRefusal = await this.deviceSocketRefusal(client, frame);
    if (deviceRefusal !== null)
      return { context: null, failure: deviceRefusal };
    const userId = await this.admittedUserId(client);
    const { sessionId, role } = client.data;
    if (sessionId === undefined || role === undefined) {
      return {
        context: null,
        failure: this.refusal(frame, client, 'quizshow_not_attached'),
      };
    }
    if (role !== 'player') {
      return {
        context: null,
        failure: this.refusal(frame, client, 'quizshow_wrong_role'),
      };
    }
    const playerId = client.data.playerId ?? null;
    if (isJoinRequired && playerId === null) {
      return {
        context: null,
        failure: this.refusal(frame, client, 'quizshow_not_joined'),
      };
    }
    return { context: { userId, sessionId, playerId }, failure: null };
  }

  private async runPlayerCommand<Success extends object>(
    client: QuizshowSocket,
    frame: string,
    bucket: 'settings' | 'submission',
    command: QuizshowPlayerCommand<Success>,
    options: QuizshowExecuteOptions = {},
  ): Promise<QuizshowAck<Success>> {
    const check = await this.playerFrameCheck(client, frame, true);
    if (check.failure !== null) return check.failure;
    const { userId, sessionId, playerId } = check.context;
    if (playerId === null) {
      return this.refusal(frame, client, 'quizshow_not_joined');
    }
    const isAllowed =
      bucket === 'settings'
        ? this.playerSettingsLimiter.tryConsume(userId)
        : this.submissionLimiter.tryConsume(playerId);
    if (!isAllowed) return this.refusal(frame, client, 'quizshow_rate_limited');
    const outcome = await this.runtime.execute(
      sessionId,
      (state, now) => command(state, playerId, now),
      options,
    );
    return this.toAck(frame, client, outcome);
  }

  /**
   * Host frames re-check the grant, the organiser and the co-host player row
   * on every command: admitted, attached as host, the host bucket, a live
   * state, then those three.
   */
  private async hostFrameCheck(
    client: QuizshowSocket,
    frame: string,
  ): Promise<QuizshowHostFrameCheck> {
    const deviceRefusal = await this.deviceSocketRefusal(client, frame);
    if (deviceRefusal !== null)
      return { context: null, failure: deviceRefusal };
    const userId = await this.admittedUserId(client);
    const { sessionId, role } = client.data;
    const failWith = (code: QuizshowErrorCode): QuizshowHostFrameCheck => ({
      context: null,
      failure: this.refusal(frame, client, code),
    });
    if (sessionId === undefined || role === undefined) {
      return failWith('quizshow_not_attached');
    }
    if (role !== 'host') return failWith('quizshow_wrong_role');
    if (!this.hostLimiter.tryConsume(userId)) {
      return failWith('quizshow_rate_limited');
    }
    const state = await this.runtime.getOrLoad(sessionId);
    if (state === null) return failWith('quizshow_session_finished');
    const { helperPairingId, helperTicketExp } = client.data;
    if (helperPairingId !== undefined) {
      // The ticket's `exp` caps the helper's rights, reattached or not.
      if (
        helperTicketExp === undefined ||
        Date.now() >= helperTicketExp * 1000
      ) {
        return failWith('quizshow_device_ticket_expired');
      }
      // A helper's rights come from the owner's pairing, read on every
      // command, so an unpair ends them even before the socket drops.
      const pairing = livePairingOf(state, helperPairingId, {
        kind: 'helper',
        userId,
      });
      if (pairing === null) return failWith('quizshow_device_unpaired');
    } else {
      // A host whose grant is gone learns nothing about the session.
      if (!(await this.featureAccess.canUseFeature('quizshow', userId))) {
        return failWith('quizshow_session_not_found');
      }
      const isOrganizer = await this.access.isScopeOrganiser(state, userId);
      if (!isOrganizer) return failWith('quizshow_not_organiser');
    }
    if (isPlayingInSession(state, userId)) {
      return failWith('quizshow_cohost_is_playing');
    }
    return { context: { userId, sessionId, state }, failure: null };
  }

  private async runHostCommand<
    Success extends { isNoop: boolean } = { isNoop: boolean },
  >(
    client: QuizshowSocket,
    frame: string,
    command: QuizshowHostCommand<Success>,
  ): Promise<QuizshowAck<Success>> {
    const check = await this.hostFrameCheck(client, frame);
    if (check.failure !== null) return check.failure;
    const { userId, sessionId } = check.context;
    const outcome = await this.runtime.execute(sessionId, (liveState, now) =>
      command(liveState, now, userId),
    );
    return this.toAck(frame, client, outcome);
  }

  private toAck<Success extends object>(
    frame: string,
    client: QuizshowSocket,
    outcome: QuizshowCommandOutcome<Success> | null,
  ): QuizshowAck<Success> {
    // The session ended between the frame's checks and its command.
    if (outcome === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    if (!outcome.ok) return this.engineRefusal(frame, client, outcome.failure);
    return { ...outcome.success, ok: true as const };
  }

  private refusalFromError(
    frame: string,
    client: QuizshowSocket,
    error: unknown,
  ): QuizshowAckFailure {
    const code = quizshowCodeOf(error);
    if (code === null) throw error;
    return this.refusal(frame, client, code);
  }

  private refusal(
    frame: string,
    client: QuizshowSocket,
    code: QuizshowErrorCode,
  ): QuizshowAckFailure {
    this.logRefusal(frame, client, code);
    return quizshowAckFailure(code);
  }

  private engineRefusal(
    frame: string,
    client: QuizshowSocket,
    failure: QuizshowAckFailure,
  ): QuizshowAckFailure {
    this.logRefusal(frame, client, failure.code);
    return failure;
  }

  private logRefusal(
    frame: string,
    client: QuizshowSocket,
    code: QuizshowErrorCode,
  ): void {
    if (UNLOGGED_REFUSALS.has(code)) return;
    const sessionPart = `session ${client.data.sessionId ?? 'none'}`;
    if (ANONYMOUS_FRAMES.has(frame)) {
      this.logger.debug(`Pulse Live ${frame} refused: ${code} ${sessionPart}`);
      return;
    }
    this.logger.debug(
      `Pulse Live ${frame} refused: ${code} ${sessionPart} player ${client.data.playerId ?? 'none'}`,
    );
  }

  private async admittedUserId(client: QuizshowSocket): Promise<string> {
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null) {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    return userId;
  }

  private allLimiters(): TokenBucketLimiter[] {
    return [
      this.handshakeLimiter,
      this.reauthLimiter,
      this.attachLimiter,
      this.playerSettingsLimiter,
      this.submissionLimiter,
      this.hostLimiter,
      this.timePingLimiter,
      this.reactionLimiter,
    ];
  }

  /** Signature, pinned algorithm and the claims-level status. */
  private async verifyHandshakeToken(
    client: QuizshowSocket,
  ): Promise<AccessTokenClaims> {
    const rawToken = this.handshakeAccessToken(client);
    if (!rawToken) throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    const secret = this.config.getOrThrow<string>('auth.jwtAccessSecret');
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(rawToken, {
        secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    if (claims.status !== UserStatus.Active) {
      throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
    }
    return claims;
  }

  /** The member credential of the handshake: `auth.token`, else the access cookie. */
  private handshakeAccessToken(client: QuizshowSocket): string | undefined {
    const fromAuth = client.handshake.auth?.token as string | undefined;
    const fromCookie = parseCookie(client.handshake.headers.cookie ?? '')[
      'access_token'
    ];
    return fromAuth ?? fromCookie;
  }

  /** The row's status, read live, so a ban lands even while the credential carries the old claim. */
  private async loadAdmittableUser(
    userId: string,
  ): Promise<Pick<User, 'id' | 'role' | 'status'>> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
    if (!user) throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    if (user.status !== UserStatus.Active) {
      throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
    }
    return user;
  }

  /** Launched, or in early access with a grant held by this member; the hidden-feature refusal otherwise. */
  private async assertFeatureOpenTo(userId: string): Promise<void> {
    if (await this.featureAccess.canUseFeature('quizshow', userId)) return;
    throw new ChatWsException('NOT_FOUND', FEATURE_HIDDEN_MESSAGE);
  }

  /** The `PlatformLockdownGuard` predicate: admins pass, moderators when allowed. */
  private async assertNotLockedOut(role: UserRole): Promise<void> {
    const settings = await this.platformSettings.get();
    if (!settings.lockdownEnabled) return;
    if (role === UserRole.Admin) return;
    if (role === UserRole.Moderator && settings.lockdownAllowsModerators) {
      return;
    }
    throw new ChatWsException(
      'PLATFORM_LOCKED',
      settings.lockdownMessage || DEFAULT_LOCKDOWN_MESSAGE,
    );
  }

  /** An absent `sid` is a pre-claim token and is admitted; a signed-out device is refused. */
  private async assertSessionLive(familyId: unknown): Promise<void> {
    if (familyId === undefined || familyId === '') return;
    if (typeof familyId !== 'string') {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    const isSessionLive = await this.refreshTokens.exists({
      where: {
        familyId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (!isSessionLive) {
      throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
    }
  }

  private dropForExpiredCredential(client: QuizshowSocket): void {
    client.emit(
      'exception',
      buildChatWsErrorFrame('TOKEN_EXPIRED', 'Token expired'),
    );
    client.disconnect(true);
  }

  /** True when the drop at `exp` is armed; false when `exp` had passed and the socket was dropped now. */
  private scheduleTokenExpiry(client: QuizshowSocket, exp: number): boolean {
    const armTimer = (delayMs: number): void => {
      const timer = setTimeout(() => {
        const remainingMs = exp * 1000 - Date.now();
        if (remainingMs <= 0) {
          this.dropForExpiredCredential(client);
          return;
        }
        armTimer(Math.min(remainingMs, MAX_SET_TIMEOUT_DELAY_MS));
      }, delayMs);
      timer.unref?.();
      client.data.expiryTimer = timer;
    };
    const millisecondsLeft = exp * 1000 - Date.now();
    if (millisecondsLeft <= 0) {
      this.dropForExpiredCredential(client);
      return false;
    }
    armTimer(Math.min(millisecondsLeft, MAX_SET_TIMEOUT_DELAY_MS));
    return true;
  }
}
