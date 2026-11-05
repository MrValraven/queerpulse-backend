/**
 * VJ (`vj`) socket namespace `/vj`. The handshake copies the Pulse Live one
 * (origin allowlist, cookie or `auth.token`, pinned JWT verify, a handshake
 * bucket on the verified user, the live user row and a live refresh-token
 * family) and admits active Admins only: any other role gets
 * `exception FORBIDDEN` with `domainCode: 'vj_not_admin'` and is dropped.
 * Admins always pass lockdown, so the namespace reads no lockdown setting.
 * The socket is dropped at the token's `exp` with `TOKEN_EXPIRED`;
 * `session:reauth` with a socket ticket extends it and reads the role again.
 *
 * Every client frame rechecks the caller's live role, cached on the socket
 * for `VJ_ROLE_RECHECK_MS`, so a demoted admin loses the socket at their
 * next frame past the cache: the frame acks `vj_not_admin`, then the
 * `exception` frame and the drop follow on the next tick.
 *
 * Stage state lives in memory in `VjStageService`; this gateway reads the
 * library for the one existence check a frame needs and fans the frames out
 * to the rooms of contract 6.3. Log lines name frames, codes, the admin user
 * id and socket ids only: payloads, overlay text, clip titles and pack names
 * stay out.
 */
import {
  Logger,
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
import { WsAllExceptionsFilter } from '../chat/ws-exception.filter';
import {
  buildChatWsErrorFrame,
  ChatWsException,
  type ChatWsErrorCode,
  type ChatWsErrorFrame,
} from '../chat/ws-error';
import { TokenBucketLimiter } from '../chat/ws-rate-limiter';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import {
  resolveAllowedOrigins,
  resolveFrontendOrigins,
} from '../config/frontend-origins';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  VjAttachPayloadDto,
  VjGoClipPayloadDto,
  VjReauthPayloadDto,
  VjScreenAdvancePayloadDto,
  VjScreenStatusPayloadDto,
  VjSetEffectsPayloadDto,
  VjSetOverlayPayloadDto,
  VjSetPackPayloadDto,
  VjSetShufflePayloadDto,
  VjSetStrobePayloadDto,
  VjSetTransitionPayloadDto,
} from './dto/vj-socket-payloads';
import {
  vjAckFailure,
  VJ_NOT_ADMIN_MESSAGE,
  VJ_SCREEN_REPLACED_MESSAGE,
} from './vj.constants';
import {
  VJ_LIBRARY_CHANGED,
  type VjAck,
  type VjAckFailure,
  type VjAttachRole,
  type VjAttachSuccess,
  type VjClientFrameName,
  type VjCommandSuccess,
  type VjLibraryChange,
  type VjReauthAck,
  type VjRemoteCommandName,
  type VjSocketErrorCode,
  type VjStageFrame,
  type VjStageState,
} from './vj.contract';
import { VjLibraryService } from './vj-library.service';
import { VjStageService } from './vj-stage.service';

/** The handshake budget per verified user: a burst of 10, then one every 10 seconds. */
const HANDSHAKE_RATE_LIMIT = { capacity: 10, refillPerSecond: 0.1 };
/** `session:reauth` per user: 10, then one every 10 seconds. */
const REAUTH_RATE_LIMIT = { capacity: 10, refillPerSecond: 0.1 };
/** `vj:attach` per socket: 10, then one every 6 seconds. */
const ATTACH_RATE_LIMIT = { capacity: 10, refillPerSecond: 1 / 6 };
/** Every `stage:*` command per socket: 40, then 10 per second, so a VJ can hammer clip taps and slider drags. */
export const VJ_COMMAND_RATE_LIMIT = { capacity: 40, refillPerSecond: 10 };
/** `screen:advance` per socket: 10, then 2 per second. */
const ADVANCE_RATE_LIMIT = { capacity: 10, refillPerSecond: 2 };
/** `screen:status` per socket: 10, then 2 per second; past it frames are dropped silently. */
const STATUS_RATE_LIMIT = { capacity: 10, refillPerSecond: 2 };

/** How long a socket's admin verdict is trusted before a frame reads `users.role` again. */
export const VJ_ROLE_RECHECK_MS = 5000;
/** How often idle buckets are reclaimed and idle stages swept. */
const VJ_SWEEP_INTERVAL_MS = 600_000;
/** The trailing throttle of `screens:update` per stage. */
const SCREENS_UPDATE_THROTTLE_MS = 250;

/** `setTimeout` clamps a longer delay to 1 ms, so the expiry timer chains legs of at most this length. */
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

/** The room every screen and remote of one admin joins; it receives `stage:state`. */
export function vjStageRoomName(adminUserId: string): string {
  return `vj:${adminUserId}`;
}

/** The room of one admin's remote sockets; it receives `screens:update`. */
export function vjRemotesRoomName(adminUserId: string): string {
  return `vj:${adminUserId}:remotes`;
}

/** The room every attached VJ socket joins; it receives `library:changed`. */
export const VJ_LIBRARY_ROOM = 'vj:library';

/** Refusals a client can repeat at no cost or that a busy remote meets in normal use; they get no log line, so a flood cannot fill the log. */
const UNLOGGED_REFUSALS: ReadonlySet<VjSocketErrorCode> =
  new Set<VjSocketErrorCode>([
    'vj_not_attached',
    'vj_wrong_role',
    'vj_rate_limited',
    'vj_stale_command',
  ]);

/** Verified access-token claims the handshake reads. */
interface AccessTokenClaims {
  sub: string;
  status: UserStatus;
  exp: number;
  sid?: string;
}

interface VjSocketData {
  /** Resolves to the admitted user id, or null for a refused handshake. */
  admission?: Promise<string | null>;
  userId?: string;
  /** Epoch seconds the current credential expires at. */
  exp?: number;
  /** The refresh-token family of the current credential, so a signed-out device can be found. */
  familyId?: string;
  expiryTimer?: NodeJS.Timeout;
  /** Claimed when an attach starts; cleared again when that attach is refused. */
  role?: VjAttachRole;
  /** Set once the stage holds this socket; frames before it answer `vj_not_attached`. */
  isAttached?: boolean;
  /** The screen id of a screen socket. */
  screenId?: string;
  /** Epoch ms of the last read that found an active Admin. */
  adminCheckedAt?: number;
  /** The role read in flight, shared by frames that arrive while it runs. */
  pendingAdminCheck?: Promise<boolean>;
  /** Set once a read found no active Admin; the drop is already scheduled. */
  hasLostAdmin?: boolean;
  /** The tail of this socket's command queue: every `stage:*` command and
   *  `screen:advance` runs after the one before it settles, so a command
   *  with an existence read cannot be overtaken by a later one. Never rejects. */
  commandChain?: Promise<void>;
}

type VjSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  VjSocketData
>;

/** The verdict of the checks every frame runs before its own rules. */
type VjFrameGate =
  { userId: string; failure: null } | { userId: null; failure: VjAckFailure };

/**
 * Same origin allowlist as the chat and Pulse Live handshakes: CORS never
 * runs on a raw WebSocket upgrade. A missing `Origin` is a non-browser client
 * and is allowed, as on `/quizshow`.
 */
function allowVjHandshakeOrigin(
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

/** The own enumerable fields of a validated payload as a plain record for `VjStageService`. */
function toPayloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {};
  return { ...(payload as Record<string, unknown>) };
}

/** Reads the lost-admin flag afresh, so a check after an await is not narrowed by one before it. */
function hasLostAdminNow(data: VjSocketData): boolean {
  return data.hasLostAdmin === true;
}

/** The `exception` frame sent before a socket whose caller is no longer an active Admin is dropped. */
function notAdminFrame(): ChatWsErrorFrame {
  return buildChatWsErrorFrame(
    'FORBIDDEN',
    VJ_NOT_ADMIN_MESSAGE,
    undefined,
    'vj_not_admin',
  );
}

@WebSocketGateway({
  namespace: '/vj',
  allowRequest: allowVjHandshakeOrigin,
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
export class VjGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer() namespace!: Namespace;
  private readonly logger = new Logger(VjGateway.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  /** One trailing `screens:update` timer per admin user id. */
  private readonly screensUpdateTimers = new Map<string, NodeJS.Timeout>();
  private readonly handshakeLimiter = new TokenBucketLimiter(
    HANDSHAKE_RATE_LIMIT,
  );
  private readonly reauthLimiter = new TokenBucketLimiter(REAUTH_RATE_LIMIT);
  private readonly attachLimiter = new TokenBucketLimiter(ATTACH_RATE_LIMIT);
  private readonly commandLimiter = new TokenBucketLimiter(
    VJ_COMMAND_RATE_LIMIT,
  );
  private readonly advanceLimiter = new TokenBucketLimiter(ADVANCE_RATE_LIMIT);
  private readonly statusLimiter = new TokenBucketLimiter(STATUS_RATE_LIMIT);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly stages: VjStageService,
    private readonly library: VjLibraryService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  /** The stage service broadcasts the strobe timeout through this binding. */
  afterInit(): void {
    this.stages.bindBroadcaster({
      broadcastState: (adminUserId: string, frame: VjStageFrame) => {
        this.namespace
          ?.to(vjStageRoomName(adminUserId))
          .emit('stage:state', frame);
      },
    });
  }

  onModuleInit(): void {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const limiter of this.allLimiters()) limiter.sweepIdle(now);
      this.stages.sweep(now);
    }, VJ_SWEEP_INTERVAL_MS);
    timer.unref?.();
    this.sweepTimer = timer;
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const timer of this.screensUpdateTimers.values()) clearTimeout(timer);
    this.screensUpdateTimers.clear();
  }

  /**
   * Stores the admission promise on the socket before the first await: Nest
   * binds the message handlers right after this starts, so a frame sent on
   * `connect` waits for the verdict.
   */
  async handleConnection(client: VjSocket): Promise<void> {
    client.data.admission = this.admit(client);
    await client.data.admission;
  }

  handleDisconnect(client: VjSocket): void {
    if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
    this.attachLimiter.clear(client.id);
    this.commandLimiter.clear(client.id);
    this.advanceLimiter.clear(client.id);
    this.statusLimiter.clear(client.id);
    const { userId, role } = client.data;
    if (userId === undefined || role === undefined) return;
    const { leadChange, hasScreenListChanged } = this.stages.detachSocket(
      userId,
      client.id,
      Date.now(),
    );
    if (leadChange?.promotedSocketId) {
      this.tellPromotedLead(leadChange.promotedSocketId);
    }
    if (hasScreenListChanged) this.scheduleScreensUpdate(userId);
  }

  /**
   * As `QuizshowGateway.handleSessionRevoked`: a signed-out device (a family
   * id) gets `SESSION_REVOKED` and is dropped; every other revocation drops
   * all of the member's sockets with no frame and lets the handshake decide.
   */
  @OnEvent(USER_SESSION_REVOKED)
  handleSessionRevoked(payload: UserSessionRevokedEvent): void {
    const frame = buildChatWsErrorFrame(
      'SESSION_REVOKED',
      'This device was signed out',
    );
    for (const socket of [...(this.namespace?.sockets.values() ?? [])]) {
      const memberSocket = socket as VjSocket;
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

  /**
   * Relays a committed library change to every attached VJ socket, then
   * broadcasts the `stage:state` frame of each stage the change touched
   * (a deleted active pack or live clip). Only the four contract fields are
   * relayed.
   */
  @OnEvent(VJ_LIBRARY_CHANGED)
  handleLibraryChanged(change: VjLibraryChange): void {
    const relayed: VjLibraryChange = {
      kind: change.kind,
      packId: change.packId,
      clipId: change.clipId,
      packIds: [...change.packIds],
    };
    this.namespace?.to(VJ_LIBRARY_ROOM).emit('library:changed', relayed);
    for (const { adminUserId, frame } of this.stages.applyLibraryChange(
      relayed,
      Date.now(),
    )) {
      this.namespace
        ?.to(vjStageRoomName(adminUserId))
        .emit('stage:state', frame);
    }
  }

  @SubscribeMessage('session:reauth')
  async handleReauth(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjReauthPayloadDto,
  ): Promise<VjReauthAck> {
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null) return { ok: false, code: 'UNAUTHORIZED' };
    if (!this.reauthLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    let exp: number;
    let familyId: string | undefined;
    const checkStartedAt = Date.now();
    try {
      const record = socketTicketService.redeem(payload.ticket, userId);
      if (record === null || record.userId !== userId) {
        throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
      }
      if (record.status !== UserStatus.Active) {
        throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
      }
      const user = await this.loadAdmittableUser(userId);
      if (user.role !== UserRole.Admin) {
        throw new ChatWsException('FORBIDDEN', VJ_NOT_ADMIN_MESSAGE);
      }
      await this.assertSessionLive(record.sessionId);
      exp = record.exp;
      familyId = record.sessionId;
    } catch (error: unknown) {
      const code: ChatWsErrorCode =
        error instanceof ChatWsException ? error.code : 'SERVER_ERROR';
      this.logger.debug(
        `VJ session:reauth refused: ${code} admin ${userId} socket ${client.id}`,
      );
      if (code === 'FORBIDDEN') {
        this.dropForLostAdmin(client);
      } else {
        this.dropForExpiredCredential(client);
      }
      return { ok: false, code };
    }
    // The socket may have gone while the checks above awaited; a dead socket arms no timer.
    if (!client.connected) return { ok: false, code: 'TOKEN_EXPIRED' };
    if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
    client.data.exp = exp;
    client.data.familyId = familyId;
    client.data.adminCheckedAt = checkStartedAt;
    if (!this.scheduleTokenExpiry(client, exp)) {
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    return { ok: true, exp };
  }

  @SubscribeMessage('vj:attach')
  async handleAttach(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjAttachPayloadDto,
  ): Promise<VjAck<VjAttachSuccess>> {
    const frame = 'vj:attach';
    const gate = await this.frameGate(client, frame, this.attachLimiter, null);
    if (gate.failure !== null) return gate.failure;
    if (client.data.role !== undefined) {
      return this.refusal(frame, client, vjAckFailure('vj_already_attached'));
    }
    // Claimed in the same synchronous segment as the check above, so two
    // attach frames in a burst cannot both pass it.
    client.data.role = payload.role;
    let ack: VjAck<VjAttachSuccess>;
    try {
      ack =
        payload.role === 'screen'
          ? await this.attachScreen(client, gate.userId, payload)
          : await this.attachRemote(client, gate.userId);
    } catch {
      // A stage or room failure answers the contract code; the log carries
      // the code and ids only.
      ack = this.refusal(frame, client, vjAckFailure('vj_server_error'));
    }
    if (!ack.ok) this.releaseAttachClaim(client);
    return ack;
  }

  @SubscribeMessage('stage:setPack')
  handleSetPack(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetPackPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setPack', payload);
  }

  @SubscribeMessage('stage:goClip')
  handleGoClip(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjGoClipPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:goClip', payload);
  }

  @SubscribeMessage('stage:setTransition')
  handleSetTransition(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetTransitionPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setTransition', payload);
  }

  @SubscribeMessage('stage:setOverlay')
  handleSetOverlay(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetOverlayPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setOverlay', payload);
  }

  @SubscribeMessage('stage:setEffects')
  handleSetEffects(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetEffectsPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setEffects', payload);
  }

  @SubscribeMessage('stage:setStrobe')
  handleSetStrobe(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetStrobePayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setStrobe', payload);
  }

  @SubscribeMessage('stage:setShuffle')
  handleSetShuffle(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetShufflePayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setShuffle', payload);
  }

  /** The lead screen's shuffle report: one membership read, then the stage rules. */
  @SubscribeMessage('screen:advance')
  handleScreenAdvance(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjScreenAdvancePayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    const frame = 'screen:advance';
    return this.queueMeteredFrame(
      client,
      frame,
      this.advanceLimiter,
      async () => {
        const gate = await this.frameGate(client, frame, null, 'screen');
        if (gate.failure !== null) return gate.failure;
        try {
          return await this.advanceScreen(client, gate.userId, payload);
        } catch {
          // A stage or library failure answers the contract code; the log
          // carries the code and ids only.
          return this.refusal(frame, client, vjAckFailure('vj_server_error'));
        }
      },
    );
  }

  /** A screen's fullscreen flag and preload report; takes no ack, so every refusal drops it silently. */
  @SubscribeMessage('screen:status')
  async handleScreenStatus(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjScreenStatusPayloadDto,
  ): Promise<void> {
    const admittedUserId =
      client.data.userId ?? (await client.data.admission) ?? null;
    if (admittedUserId === null) return;
    const gate = await this.frameGate(
      client,
      'screen:status',
      this.statusLimiter,
      'screen',
    );
    if (gate.failure !== null) return;
    let isStored: boolean;
    try {
      isStored = this.stages.updateScreenStatus(
        gate.userId,
        client.id,
        toPayloadRecord(payload),
        Date.now(),
      );
    } catch {
      // No ack to carry the code: the frame is dropped and the log carries
      // the code and ids only.
      this.refusal('screen:status', client, vjAckFailure('vj_server_error'));
      return;
    }
    if (isStored) this.scheduleScreensUpdate(gate.userId);
  }

  private async admit(client: VjSocket): Promise<string | null> {
    try {
      const claims = await this.verifyHandshakeToken(client);
      // Metered on the verified user id, before any database read.
      if (!this.handshakeLimiter.tryConsume(claims.sub)) {
        throw new ChatWsException(
          'RATE_LIMITED',
          'You are reconnecting too quickly',
        );
      }
      const checkStartedAt = Date.now();
      const user = await this.loadAdmittableUser(claims.sub);
      if (user.role !== UserRole.Admin) {
        this.logger.debug(
          `VJ handshake refused: FORBIDDEN vj_not_admin socket ${client.id}`,
        );
        this.refuseHandshake(client, notAdminFrame());
        return null;
      }
      await this.assertSessionLive(claims.sid);
      // The client may have gone while the checks above awaited.
      if (!client.connected) return null;
      client.data.userId = user.id;
      client.data.exp = claims.exp;
      client.data.familyId = claims.sid;
      client.data.adminCheckedAt = checkStartedAt;
      if (!this.scheduleTokenExpiry(client, claims.exp)) {
        client.data.userId = undefined;
        return null;
      }
      return user.id;
    } catch (error: unknown) {
      if (error instanceof ChatWsException) {
        const frame = error.getError() as ChatWsErrorFrame;
        this.logger.debug(
          `VJ handshake refused: ${frame.code} socket ${client.id}`,
        );
        this.refuseHandshake(client, frame);
        return null;
      }
      this.logger.error(
        `VJ handshake failed: SERVER_ERROR socket ${client.id}`,
      );
      this.refuseHandshake(
        client,
        buildChatWsErrorFrame('SERVER_ERROR', 'Internal server error'),
      );
      return null;
    }
  }

  private refuseHandshake(client: VjSocket, frame: ChatWsErrorFrame): void {
    client.emit('exception', frame);
    client.disconnect(true);
  }

  /**
   * The checks every frame runs before its own rules (note 8): admission,
   * the frame's bucket, the admin recheck, then for every frame but attach
   * `vj_not_attached` and `vj_wrong_role`. The bucket runs before the
   * recheck so a flood never reaches the database. A null `limiter` means
   * the frame was metered on arrival by `queueMeteredFrame`.
   */
  private async frameGate(
    client: VjSocket,
    frame: VjClientFrameName,
    limiter: TokenBucketLimiter | null,
    expectedRole: VjAttachRole | null,
  ): Promise<VjFrameGate> {
    const userId = await this.admittedUserId(client);
    const deny = (code: VjSocketErrorCode): VjFrameGate => ({
      userId: null,
      failure: this.refusal(frame, client, vjAckFailure(code)),
    });
    if (limiter !== null && !limiter.tryConsume(client.id)) {
      return deny('vj_rate_limited');
    }
    const adminRefusal = await this.recheckAdmin(client, userId);
    if (adminRefusal !== null) return deny(adminRefusal);
    if (expectedRole !== null) {
      if (client.data.isAttached !== true) return deny('vj_not_attached');
      if (client.data.role !== expectedRole) return deny('vj_wrong_role');
    }
    return { userId, failure: null };
  }

  /**
   * Null while the caller is an active Admin. The verdict is trusted for
   * `VJ_ROLE_RECHECK_MS`; an older one reads `users.role, users.status`
   * first, shared by every frame that arrives while the read runs. A caller
   * who lost the role gets `vj_not_admin` and is dropped after the ack.
   */
  private async recheckAdmin(
    client: VjSocket,
    userId: string,
  ): Promise<VjSocketErrorCode | null> {
    if (client.data.hasLostAdmin === true) return 'vj_not_admin';
    const checkStartedAt = Date.now();
    const checkedAt = client.data.adminCheckedAt;
    if (
      checkedAt !== undefined &&
      checkStartedAt - checkedAt < VJ_ROLE_RECHECK_MS
    ) {
      return null;
    }
    let isActiveAdmin: boolean;
    try {
      client.data.pendingAdminCheck ??= this.readIsActiveAdmin(userId).finally(
        () => {
          client.data.pendingAdminCheck = undefined;
        },
      );
      isActiveAdmin = await client.data.pendingAdminCheck;
    } catch {
      return 'vj_server_error';
    }
    // A `session:reauth` that found the role gone while this read awaited
    // has already scheduled the drop; this frame must not apply.
    if (hasLostAdminNow(client.data)) return 'vj_not_admin';
    if (!isActiveAdmin) {
      this.dropForLostAdmin(client);
      return 'vj_not_admin';
    }
    client.data.adminCheckedAt = Math.max(
      client.data.adminCheckedAt ?? 0,
      checkStartedAt,
    );
    return null;
  }

  private async readIsActiveAdmin(userId: string): Promise<boolean> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
    return (
      user !== null &&
      user.role === UserRole.Admin &&
      user.status === UserStatus.Active
    );
  }

  /** The `exception FORBIDDEN vj_not_admin` frame and the drop, on the next tick so the frame's ack leaves first. */
  private dropForLostAdmin(client: VjSocket): void {
    // Scheduled once per socket, however many frames find the role gone.
    if (client.data.hasLostAdmin === true) return;
    client.data.hasLostAdmin = true;
    setImmediate(() => {
      if (!client.connected) return;
      client.emit('exception', notAdminFrame());
      client.disconnect(true);
    });
  }

  /**
   * A screen attach: the two restore reads only while the stage would adopt
   * a restore, then the stage rules, the rooms, the replaced socket, the ack,
   * and on the next tick `stage:state`, `screen:role` and `screens:update`.
   */
  private async attachScreen(
    client: VjSocket,
    userId: string,
    payload: VjAttachPayloadDto,
  ): Promise<VjAck<VjAttachSuccess>> {
    const frame = 'vj:attach';
    const restoreLookups = { isActivePackKnown: false, isLiveClipKnown: false };
    if (this.stages.shouldAdoptRestore(userId)) {
      const lookupIds = this.stages.restoreLookupIds(payload.restoreState);
      try {
        const [isActivePackKnown, isLiveClipKnown] = await Promise.all([
          lookupIds.packId === null
            ? false
            : this.library.packExists(lookupIds.packId),
          lookupIds.clipId === null
            ? false
            : this.library.clipExists(lookupIds.clipId),
        ]);
        restoreLookups.isActivePackKnown = isActivePackKnown;
        restoreLookups.isLiveClipKnown = isLiveClipKnown;
      } catch {
        return this.refusal(frame, client, vjAckFailure('vj_server_error'));
      }
    }
    // A socket that left while the reads awaited must not become a screen
    // entry; its ack never arrives, so the code only releases the claim.
    if (!client.connected) return vjAckFailure('vj_not_attached');
    const outcome = this.stages.attachScreen(
      {
        adminUserId: userId,
        socketId: client.id,
        screenId: payload.screenId,
        restoreState: payload.restoreState,
        restoreLookups,
      },
      Date.now(),
    );
    if (!outcome.ok) return this.refusal(frame, client, outcome.failure);
    client.data.isAttached = true;
    client.data.screenId =
      typeof payload.screenId === 'string' ? payload.screenId : undefined;
    if (outcome.replacedSocketId !== null) {
      this.dropReplacedScreen(outcome.replacedSocketId, userId);
    }
    await client.join([vjStageRoomName(userId), VJ_LIBRARY_ROOM]);
    const promotedSocketId = outcome.leadChange?.promotedSocketId ?? null;
    this.emitOnNextTick(userId, () => {
      const state = this.stages.getState(userId) ?? outcome.state;
      const stageFrame: VjStageFrame = {
        state,
        cause: outcome.isRestored ? 'restore' : 'attach',
        sourceClientId: null,
      };
      if (outcome.isRestored) {
        this.namespace
          ?.to(vjStageRoomName(userId))
          .emit('stage:state', stageFrame);
      } else if (client.connected) {
        client.emit('stage:state', stageFrame);
      }
      if (client.connected) {
        client.emit('screen:role', {
          isLead: this.stages.leadSocketIdOf(userId) === client.id,
        });
      }
      if (promotedSocketId !== null && promotedSocketId !== client.id) {
        this.tellPromotedLead(promotedSocketId);
      }
      this.scheduleScreensUpdate(userId);
    });
    return {
      ok: true,
      role: 'screen',
      connectionExpiresAt: (client.data.exp ?? 0) * 1000,
      stageEpoch: outcome.state.stageEpoch,
      isRestored: outcome.isRestored,
      isLead: outcome.isLead,
    };
  }

  /** A remote attach: its rooms, the ack, then `stage:state` and the screen list to this socket alone. */
  private async attachRemote(
    client: VjSocket,
    userId: string,
  ): Promise<VjAck<VjAttachSuccess>> {
    // A socket that left while the gate awaited must not join the stage.
    if (!client.connected) return vjAckFailure('vj_not_attached');
    const attachedState = this.stages.attachRemote(
      userId,
      client.id,
      Date.now(),
    );
    client.data.isAttached = true;
    await client.join([
      vjStageRoomName(userId),
      vjRemotesRoomName(userId),
      VJ_LIBRARY_ROOM,
    ]);
    this.emitOnNextTick(userId, () => {
      if (!client.connected) return;
      const state: VjStageState = this.stages.getState(userId) ?? attachedState;
      client.emit('stage:state', {
        state,
        cause: 'attach',
        sourceClientId: null,
      } satisfies VjStageFrame);
      client.emit('screens:update', {
        screens: this.stages.listScreens(userId, Date.now()),
      });
    });
    return {
      ok: true,
      role: 'remote',
      connectionExpiresAt: (client.data.exp ?? 0) * 1000,
      stageEpoch: attachedState.stageEpoch,
      isRestored: false,
      isLead: null,
    };
  }

  private releaseAttachClaim(client: VjSocket): void {
    if (client.data.isAttached === true) return;
    client.data.role = undefined;
  }

  /** The older socket of a screen id another socket took over gets `vj_screen_replaced` and is dropped. */
  private dropReplacedScreen(socketId: string, userId: string): void {
    const replaced = this.namespace?.sockets.get(socketId);
    if (replaced === undefined) return;
    this.logger.debug(`VJ screen replaced: admin ${userId} socket ${socketId}`);
    replaced.emit(
      'exception',
      buildChatWsErrorFrame(
        'BAD_REQUEST',
        VJ_SCREEN_REPLACED_MESSAGE,
        undefined,
        'vj_screen_replaced',
      ),
    );
    replaced.disconnect(true);
  }

  /** The advance rules past the common checks: the stage's checks, the one membership read, then the shuffle step. */
  private async advanceScreen(
    client: VjSocket,
    userId: string,
    payload: unknown,
  ): Promise<VjAck<VjCommandSuccess>> {
    const frame = 'screen:advance';
    const fields = toPayloadRecord(payload);
    const prepared = this.stages.prepareScreenAdvance(
      userId,
      client.id,
      fields,
    );
    if (prepared.failure !== null) {
      return this.refusal(frame, client, prepared.failure);
    }
    const isClipInPack = await this.library.isClipInPack(
      prepared.packId,
      prepared.clipId,
    );
    const outcome = this.stages.applyScreenAdvance(
      userId,
      client.id,
      fields,
      isClipInPack,
      Date.now(),
    );
    if (!outcome.ok) return this.refusal(frame, client, outcome.failure);
    this.broadcastOnNextTick(userId, outcome.frame);
    return { ok: true, ...outcome.success };
  }

  /**
   * Every remote command: the common checks, the stage's client id, stale
   * and field rules, the one existence read when the command names an id,
   * then the stage applies it and the frame goes to the whole stage on the
   * next tick, after the ack. Commands of one socket run in arrival order.
   */
  private runRemoteCommand(
    client: VjSocket,
    name: VjRemoteCommandName,
    payload: unknown,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.queueMeteredFrame(
      client,
      name,
      this.commandLimiter,
      async () => {
        const gate = await this.frameGate(client, name, null, 'remote');
        if (gate.failure !== null) return gate.failure;
        try {
          return await this.applyCommand(client, gate.userId, name, payload);
        } catch {
          // A stage or library failure answers the contract code; the log
          // carries the code and ids only.
          return this.refusal(name, client, vjAckFailure('vj_server_error'));
        }
      },
    );
  }

  /**
   * Meters a frame on arrival, then queues `work` behind every command this
   * socket sent before it. A frame past its bucket answers
   * `vj_rate_limited` at once and never joins the queue, so a flood cannot
   * grow it. Without the queue a command that awaits an existence read (a
   * `stage:goClip`) could be overtaken by a later one that reads nothing (a
   * fade slider frame), which records the higher sequence and turns the
   * earlier tap into `vj_stale_command`. A failed command never blocks the
   * next one.
   */
  private queueMeteredFrame<Success extends object>(
    client: VjSocket,
    frame: VjClientFrameName,
    limiter: TokenBucketLimiter,
    work: () => Promise<VjAck<Success>>,
  ): Promise<VjAck<Success>> {
    if (!limiter.tryConsume(client.id)) {
      return Promise.resolve(
        this.refusal(frame, client, vjAckFailure('vj_rate_limited')),
      );
    }
    const previous = client.data.commandChain ?? Promise.resolve();
    const result = previous.then(work);
    client.data.commandChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The command rules past the common checks. A refusal from the prepare
   * step is answered through `applyRemoteCommand`, which reruns the same
   * checks and records the sequence (note 9), so a late duplicate of a
   * refused command answers `vj_stale_command`.
   */
  private async applyCommand(
    client: VjSocket,
    userId: string,
    name: VjRemoteCommandName,
    payload: unknown,
  ): Promise<VjAck<VjCommandSuccess>> {
    const fields = toPayloadRecord(payload);
    const prepared = this.stages.prepareRemoteCommand(userId, name, fields);
    if (prepared.failure !== null) {
      const recorded = this.stages.applyRemoteCommand(
        userId,
        name,
        fields,
        false,
        Date.now(),
      );
      if (recorded.ok) {
        // The prepare and the apply run in one synchronous segment on the
        // same state, so this branch means the two disagree. Clients still
        // get the applied state; the sender gets the server error.
        this.broadcastOnNextTick(userId, recorded.frame);
        return this.refusal(name, client, vjAckFailure('vj_server_error'));
      }
      return this.refusal(name, client, recorded.failure);
    }
    const isLookupKnown =
      prepared.lookup === null
        ? true
        : prepared.lookup.kind === 'pack'
          ? await this.library.packExists(prepared.lookup.id)
          : await this.library.clipExists(prepared.lookup.id);
    const outcome = this.stages.applyRemoteCommand(
      userId,
      name,
      fields,
      isLookupKnown,
      Date.now(),
    );
    if (!outcome.ok) return this.refusal(name, client, outcome.failure);
    this.broadcastOnNextTick(userId, outcome.frame);
    return { ok: true, ...outcome.success };
  }

  /** `stage:state` to the whole stage on the next tick; nothing for a noop. */
  private broadcastOnNextTick(
    adminUserId: string,
    frame: VjStageFrame | null,
  ): void {
    if (frame === null) return;
    this.emitOnNextTick(adminUserId, () => {
      this.namespace
        ?.to(vjStageRoomName(adminUserId))
        .emit('stage:state', frame);
    });
  }

  /** Runs a frame builder on the next tick, after the handler's ack; a builder that throws logs the admin id only. */
  private emitOnNextTick(adminUserId: string, emitFrames: () => void): void {
    setImmediate(() => {
      try {
        emitFrames();
      } catch {
        this.logger.error(`VJ frame emit failed: admin ${adminUserId}`);
      }
    });
  }

  private tellPromotedLead(socketId: string): void {
    this.namespace?.to(socketId).emit('screen:role', { isLead: true });
  }

  /** A trailing `screens:update` to the remotes room, at most one per stage per `SCREENS_UPDATE_THROTTLE_MS`. */
  private scheduleScreensUpdate(adminUserId: string): void {
    if (this.screensUpdateTimers.has(adminUserId)) return;
    const timer = setTimeout(() => {
      this.screensUpdateTimers.delete(adminUserId);
      this.namespace
        ?.to(vjRemotesRoomName(adminUserId))
        .emit('screens:update', {
          screens: this.stages.listScreens(adminUserId, Date.now()),
        });
    }, SCREENS_UPDATE_THROTTLE_MS);
    timer.unref?.();
    this.screensUpdateTimers.set(adminUserId, timer);
  }

  private refusal(
    frame: VjClientFrameName,
    client: VjSocket,
    failure: VjAckFailure,
  ): VjAckFailure {
    if (!UNLOGGED_REFUSALS.has(failure.code)) {
      this.logger.debug(
        `VJ ${frame} refused: ${failure.code} admin ${client.data.userId ?? 'none'} socket ${client.id}`,
      );
    }
    return failure;
  }

  private async admittedUserId(client: VjSocket): Promise<string> {
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
      this.commandLimiter,
      this.advanceLimiter,
      this.statusLimiter,
    ];
  }

  /** Signature, pinned algorithm and the claims-level status. */
  private async verifyHandshakeToken(
    client: VjSocket,
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

  private dropForExpiredCredential(client: VjSocket): void {
    client.emit(
      'exception',
      buildChatWsErrorFrame('TOKEN_EXPIRED', 'Token expired'),
    );
    client.disconnect(true);
  }

  /** True when the drop at `exp` is armed; false when `exp` had passed and the socket was dropped now. */
  private scheduleTokenExpiry(client: VjSocket, exp: number): boolean {
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
