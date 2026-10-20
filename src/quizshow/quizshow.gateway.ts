/**
 * Pulse Live (`quizshow`) socket namespace `/quizshow`. The handshake copies
 * the magazine desk gateway (origin allowlist, cookie or `auth.token`, pinned
 * JWT verify, a handshake bucket on the verified user, live status, lockdown
 * and a live refresh-token family) and checks feature access itself, since
 * the global feature guards cover HTTP only: while Pulse Live is unlaunched,
 * only members holding an early-access grant are admitted, and
 * `session:reauth` checks the grant again, so a revoke drops a live socket at
 * its next reauth. The socket is dropped at the token's `exp` with
 * `TOKEN_EXPIRED`; `session:reauth` with a socket ticket extends it, as on
 * `/chat`.
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
import { textHasBlockedTerm } from '../common/blocked-terms';
import { DEFAULT_LOCKDOWN_MESSAGE } from '../common/lockdown.constants';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import {
  resolveAllowedOrigins,
  resolveFrontendOrigins,
} from '../config/frontend-origins';
import { FeatureAccessService } from '../early-access/feature-access.service';
import { Event } from '../events/entities/event.entity';
import { EventsService } from '../events/events.service';
import { isEarlyAccessFeature, isFeatureLaunched } from '../launchedFeatures';
import { PLATFORM_LOCKDOWN_ENABLED } from '../platform-settings/platform-settings.events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  QuizshowAddTimePayload,
  QuizshowAnswerPayloadDto,
  QuizshowAnswerSubmitPayload,
  QuizshowAttachPayload,
  QuizshowAvatarPayload,
  QuizshowCreateTeamPayload,
  QuizshowExtraTimePayload,
  QuizshowHideAnswerPayload,
  QuizshowJokerPayload,
  QuizshowLobbyJoinPayload,
  QuizshowLobbyTeamChoiceDto,
  QuizshowPhaseCommandPayload,
  QuizshowPickFavouritePayload,
  QuizshowPickTeamPayload,
  QuizshowReauthPayload,
  QuizshowRemovePlayerPayload,
  QuizshowRenameTeamPayload,
  QuizshowSetNamePayload,
  QuizshowSetScreenMutedPayload,
  QuizshowTimePingPayload,
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
  type QuizshowSessionStatus,
} from './quizshow.contract';
import {
  hostAddTime,
  hostEnd,
  hostHideAnswer,
  hostNext,
  hostPause,
  hostPickFavourite,
  hostRemovePlayer,
  hostRenameTeam,
  hostResume,
  hostReveal,
  hostSetScreenMuted,
  hostShowAnswers,
  hostSkip,
  hostStart,
  type QuizshowHostOutcome,
} from './quizshow-engine-phases';
import {
  createTeam,
  joinLobby,
  pickTeam,
  playJoker,
  setAvatarShown,
  setExtraTime,
  setScreenName,
  submitAnswer,
  submitVote,
  type QuizshowJoinTeamChoice,
} from './quizshow-engine-players';
import { recordAttachedOrganiser, refuse, toMe } from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowLivePlayer,
  QuizshowLiveState,
} from './quizshow-engine-types';
import { quizshowAckFailure, quizshowCodeOf } from './quizshow-errors';
import {
  buildSessionState,
  quizshowPlayerRoomName,
  quizshowRoomName,
  type QuizshowSessionStateViewer,
} from './quizshow-frames';
import { quizshowWriteFailureCode } from './quizshow-persistence.service';
import {
  QuizshowRuntimeService,
  type QuizshowExecuteOptions,
} from './quizshow-runtime.service';

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
}

type QuizshowSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  QuizshowSocketData
>;

export type QuizshowReauthAck =
  { ok: true; exp: number } | { ok: false; code: ChatWsErrorCode };

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

type QuizshowHostCommand = (
  state: QuizshowLiveState,
  now: number,
  userId: string,
) => QuizshowHostOutcome;

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

/** An organiser with a non-removed player row is a co-host playing this session. */
function isPlayingInSession(state: QuizshowLiveState, userId: string): boolean {
  const player = livePlayerOf(state, userId);
  return player !== null && player.removedAt === null;
}

/** The first name of the profile as a starting screen name; blank when it holds a blocked term. */
function suggestedScreenNameOf(
  profile: Pick<Profile, 'firstName'> | null,
): string {
  const firstName = (profile?.firstName ?? '')
    .trim()
    .slice(0, QUIZSHOW_LIMITS.screenNameMax)
    .trim();
  return textHasBlockedTerm(firstName) ? '' : firstName;
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
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(QuizshowSessionRecord)
    private readonly sessions: Repository<QuizshowSessionRecord>,
    private readonly platformSettings: PlatformSettingsService,
    private readonly featureAccess: FeatureAccessService,
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
    this.attachLimiter.clear(client.id);
    this.timePingLimiter.clear(client.id);
    const { sessionId, role, playerId } = client.data;
    if (sessionId !== undefined && role === 'player') {
      this.runtime.noteSocketDetached(sessionId, playerId ?? null);
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
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null) return { ok: false, code: 'UNAUTHORIZED' };
    if (!this.reauthLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
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
      await this.assertFeatureOpenTo(user.id);
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
    if (!this.scheduleTokenExpiry(client, exp)) {
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    return { ok: true, exp };
  }

  @SubscribeMessage('time:ping')
  async handleTimePing(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowTimePingPayload,
  ): Promise<void> {
    const serverReceivedAt = Date.now();
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null) return;
    if (!this.timePingLimiter.tryConsume(client.id)) return;
    client.emit('time:pong', {
      clientSentAt: payload.clientSentAt,
      serverReceivedAt,
      serverSentAt: Date.now(),
    });
  }

  @SubscribeMessage('quizshow:attach')
  async handleAttach(
    @ConnectedSocket() client: QuizshowSocket,
    @MessageBody() payload: QuizshowAttachPayload,
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    const userId = await this.admittedUserId(client);
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
      ack =
        payload.as === 'player'
          ? await this.attachPlayer(client, userId, payload.sessionId)
          : await this.attachOrganiser(
              client,
              userId,
              payload.sessionId,
              payload.as,
            );
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
    if (existingPlayer !== null) {
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
    const event = await this.events.findOne({ where: { id: state.eventId } });
    if (event === null) {
      return this.refusal(frame, client, 'quizshow_session_not_found');
    }
    const isRestricted = await this.access.isRestricted(userId);
    let isCohostPlayer: boolean;
    try {
      const mayPlay = await this.access.assertMayPlay({
        session: this.sessionAccessOf(state),
        event,
        userId,
        isRestricted,
        shouldCheckCapacity: true,
      });
      isCohostPlayer = mayPlay.isCohost;
    } catch (error: unknown) {
      return this.refusalFromError(frame, client, error);
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

  private async admit(client: QuizshowSocket): Promise<string | null> {
    // Closed to everyone, so refused before any token or database work. In
    // early access the grant is checked once the user is known.
    if (!isFeatureLaunched('quizshow') && !isEarlyAccessFeature('quizshow')) {
      this.refuseHandshake(
        client,
        buildChatWsErrorFrame('NOT_FOUND', FEATURE_HIDDEN_MESSAGE),
      );
      return null;
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
      await this.assertFeatureOpenTo(user.id);
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
  }

  private refuseHandshake(
    client: QuizshowSocket,
    frame: ChatWsErrorFrame,
  ): void {
    client.emit('exception', frame);
    client.disconnect(true);
  }

  private async attachOrganiser(
    client: QuizshowSocket,
    userId: string,
    sessionId: string,
    role: 'screen' | 'host',
  ): Promise<QuizshowAck<QuizshowAttachSuccess>> {
    const frame = 'quizshow:attach';
    const lookup = await this.loadAttachableState(sessionId);
    if (lookup.state === null) {
      return this.refusal(frame, client, lookup.refusal);
    }
    const state = lookup.state;
    const event = await this.events.findOne({ where: { id: state.eventId } });
    if (event === null) {
      return this.refusal(frame, client, 'quizshow_session_not_found');
    }
    let isOrganizer: boolean;
    try {
      isOrganizer = await this.eventsService.assertCanView(event, userId);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        return this.refusal(frame, client, 'quizshow_session_not_found');
      }
      throw error;
    }
    if (!isOrganizer) {
      return this.refusal(frame, client, 'quizshow_not_organiser');
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
    const event = await this.events.findOne({ where: { id: state.eventId } });
    if (event === null) {
      return this.refusal(frame, client, 'quizshow_session_not_found');
    }
    const isRestricted = await this.access.isRestricted(userId);
    try {
      await this.access.assertMayPlay({
        session: this.sessionAccessOf(state),
        event,
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
    if (livePlayer !== null) {
      await this.bindPlayer(client, sessionId, livePlayer.playerId);
    }
    this.scheduleSessionState(client, state, {
      role: 'player',
      playerId: client.data.playerId ?? null,
      suggestedScreenName: suggestedScreenNameOf(profile),
    });
    return this.attachSuccess(client, 'player');
  }

  private attachSuccess(
    client: QuizshowSocket,
    role: QuizshowAttachRole,
  ): QuizshowAck<QuizshowAttachSuccess> {
    return {
      ok: true,
      role,
      connectionExpiresAt: (client.data.exp ?? 0) * 1000,
    };
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
    await client.join(quizshowPlayerRoomName(sessionId, playerId));
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
      eventId: state.eventId,
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

  /** Host frames re-check the organiser and the co-host player row on every command. */
  private async runHostCommand(
    client: QuizshowSocket,
    frame: string,
    command: QuizshowHostCommand,
  ): Promise<QuizshowAck<{ isNoop: boolean }>> {
    const userId = await this.admittedUserId(client);
    const { sessionId, role } = client.data;
    if (sessionId === undefined || role === undefined) {
      return this.refusal(frame, client, 'quizshow_not_attached');
    }
    if (role !== 'host') {
      return this.refusal(frame, client, 'quizshow_wrong_role');
    }
    if (!this.hostLimiter.tryConsume(userId)) {
      return this.refusal(frame, client, 'quizshow_rate_limited');
    }
    const state = await this.runtime.getOrLoad(sessionId);
    if (state === null) {
      return this.refusal(frame, client, 'quizshow_session_finished');
    }
    const isOrganizer = await this.eventsService.isOrganizer(
      state.eventId,
      userId,
    );
    if (!isOrganizer) {
      return this.refusal(frame, client, 'quizshow_not_organiser');
    }
    if (isPlayingInSession(state, userId)) {
      return this.refusal(frame, client, 'quizshow_cohost_is_playing');
    }
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
    this.logger.debug(
      `Pulse Live ${frame} refused: ${code} session ${client.data.sessionId ?? 'none'} player ${client.data.playerId ?? 'none'}`,
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
    ];
  }

  /** Signature, pinned algorithm and the claims-level status. */
  private async verifyHandshakeToken(
    client: QuizshowSocket,
  ): Promise<AccessTokenClaims> {
    const fromAuth = client.handshake.auth?.token as string | undefined;
    const fromCookie = parseCookie(client.handshake.headers.cookie ?? '')[
      'access_token'
    ];
    const rawToken = fromAuth ?? fromCookie;
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
