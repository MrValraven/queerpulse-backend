/**
 * VJ (`vj`) socket namespace `/vj`. The handshake copies the Pulse Live one
 * (origin allowlist, cookie or `auth.token`, pinned JWT verify, a handshake
 * bucket on the verified user, the live user row and a live refresh-token
 * family) and admits an active Admin or an active holder of the
 * `vj_operator` staff grant (`isAdminOrHoldsStaffRole`, the rule
 * `RolesOrStaffGuard` applies to `admin/vj`). Anyone else gets
 * `exception FORBIDDEN` with `domainCode: 'vj_not_admin'` and is dropped; the
 * wire code keeps its name, and its message names the missing VJ access.
 * Each caller drives a stage of their own, keyed by their user id.
 *
 * Lockdown: an Admin always passes. A grant holder meets the
 * `PlatformLockdownGuard` rule at the handshake and at `session:reauth`
 * (a moderator passes when the lockdown allows moderators, everyone else gets
 * `PLATFORM_LOCKED`), and switching a lockdown on drops every socket admitted
 * through the grant so the handshake decides who comes back. Single replica,
 * like the Pulse Live and desk presence gateways.
 * The socket is dropped at the token's `exp` with `TOKEN_EXPIRED`;
 * `session:reauth` with a socket ticket extends it and reads the access again.
 *
 * Every client frame rechecks the caller's live role and grant, cached on the
 * socket for `VJ_ROLE_RECHECK_MS`, so a demoted admin or an operator whose
 * grant was revoked loses the socket at their next frame past the cache: the
 * frame acks `vj_not_admin`, then the `exception` frame and the drop follow
 * on the next tick.
 *
 * Stage state lives in memory in `VjStageService`, which also reads the
 * lookups of every stage command (contract 7.7). This gateway reads the
 * restore lookups of a screen attach and the set list follow reads a library
 * change needs, saves Loop before `stage:setlistSetLooping` lands, stamps `serverNow` on every ack (contract 7.2) and fans the frames
 * out to the rooms of contract 6.3. Log lines name frames, codes, the stage
 * owner's user id, socket ids and entity ids only: payloads, overlay text, clip
 * titles, pack, scene and set list names, countdown labels and event titles
 * stay out.
 */
import {
  HttpException,
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
import { isAdminOrHoldsStaffRole } from '../auth/staff-grant-access';
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
import { DEFAULT_LOCKDOWN_MESSAGE } from '../common/lockdown.constants';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import {
  resolveAllowedOrigins,
  resolveFrontendOrigins,
} from '../config/frontend-origins';
import { PLATFORM_LOCKDOWN_ENABLED } from '../platform-settings/platform-settings.events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import type { StaffRoleId } from '../users/staff-roles.registry';
import {
  VjAttachPayloadDto,
  VjClockSyncPayloadDto,
  VjGoClipPayloadDto,
  VjGoGeneratorPayloadDto,
  VjReauthPayloadDto,
  VjRecallScenePayloadDto,
  VjResetLookPayloadDto,
  VjScreenAdvancePayloadDto,
  VjScreenIdentifyPayloadDto,
  VjScreenStatusPayloadDto,
  VjSetCountdownPayloadDto,
  VjSetEffectsPayloadDto,
  VjSetEventCardPayloadDto,
  VjSetlistSelectPayloadDto,
  VjSetlistSetLoopingPayloadDto,
  VjSetlistSetPlayingPayloadDto,
  VjSetlistStepPayloadDto,
  VjSetLogoPayloadDto,
  VjSetMixPayloadDto,
  VjSetOverlayPayloadDto,
  VjSetPackPayloadDto,
  VjSetRenderModePayloadDto,
  VjSetScreenOverridePayloadDto,
  VjSetShufflePayloadDto,
  VjSetStrobePayloadDto,
  VjSetTempoPayloadDto,
  VjSetTransitionPayloadDto,
  VjSwapMixPayloadDto,
} from './dto/vj-socket-payloads';
import { vjAttachApplyAt } from './stage/vj-quantize';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  isOneOf,
  isRecord,
  isUuidString,
  type VjLookupResults,
} from './stage/vj-rule-kit';
import {
  vjAckFailure,
  VJ_NOT_ADMIN_MESSAGE,
  VJ_SCREEN_REPLACED_MESSAGE,
  VJ_STOPPED_MESSAGE,
  type VjRefusalCode,
} from './vj.constants';
import {
  VJ_CONTRACT_VERSION,
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  VJ_RENDER_MODES,
  type VjAck,
  type VjAckFailure,
  type VjAttachRole,
  type VjAttachSuccess,
  type VjClientFrameName,
  type VjCommandSuccess,
  type VjLibraryChange,
  type VjReauthAck,
  type VjRemoteCommandName,
  type VjRenderMode,
  type VjScreenIdentifyFrame,
  type VjScreenRenderModeFrame,
  type VjSetlistFollowRead,
  type VjSocketErrorCode,
  type VjStageFrame,
  type VjStageState,
  type VjWsTransportCode,
} from './vj.contract';
import { readVjCreatorProfiles } from './vj-library-reads';
import {
  toVjLiveDTO,
  type VjLiveDTO,
  type VjLiveRemoteSnapshot,
  type VjLiveStageSnapshot,
  type VjLiveStoppedDTO,
} from './vj-live-response';
import { resolveVjLookups } from './vj-lookup-resolver';
import { toVjCreator } from './vj-response';
import { VjSetlistService } from './vj-setlist.service';
import { VjStageReadsService } from './vj-stage-reads.service';
import {
  VjStageService,
  type VjRemoteWriteRefusal,
  type VjScreenAttachOutcome,
  type VjStageOutcome,
} from './vj-stage.service';

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
/** `stage:setMix` per socket: 60, then 25 per second, so a crossfader drag (20 per second) stays under it (contract 7.12). */
export const VJ_MIX_RATE_LIMIT = { capacity: 60, refillPerSecond: 25 };
/** `stage:setEffects` per socket: 60, then 25 per second, for pad drumming and effect sliders (contract 7.12). */
export const VJ_EFFECTS_RATE_LIMIT = { capacity: 60, refillPerSecond: 25 };
/** `screen:identify` per socket: 5, then one every 2 seconds. */
const IDENTIFY_RATE_LIMIT = { capacity: 5, refillPerSecond: 0.5 };
/** `screens:setRenderMode` per socket: 5, then one every 2 seconds. */
const RENDER_MODE_RATE_LIMIT = { capacity: 5, refillPerSecond: 0.5 };
/** `clock:sync` per socket: 10, then one per second. */
const CLOCK_SYNC_RATE_LIMIT = { capacity: 10, refillPerSecond: 1 };

/** The staff grant that opens VJ to a caller who is not an Admin. */
const VJ_STAFF_ROLES: readonly StaffRoleId[] = ['vj_operator'];

/** How long a socket's access verdict (an active Admin or an active
 *  `vj_operator` holder) is trusted before a frame reads it again. */
export const VJ_ROLE_RECHECK_MS = 5000;
/** How often idle buckets are reclaimed and idle stages swept. */
const VJ_SWEEP_INTERVAL_MS = 600_000;
/** The trailing throttle of `screens:update` per stage. */
const SCREENS_UPDATE_THROTTLE_MS = 250;

/** `setTimeout` clamps a longer delay to 1 ms, so the expiry timer chains legs of at most this length. */
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

/** The room every screen and remote of one stage owner (an Admin or a VJ
 *  operator) joins; it receives `stage:state`. */
export function vjStageRoomName(adminUserId: string): string {
  return `vj:${adminUserId}`;
}

/** The room of one stage owner's remote sockets; it receives `screens:update`. */
export function vjRemotesRoomName(adminUserId: string): string {
  return `vj:${adminUserId}:remotes`;
}

/** The room every attached VJ socket joins; it receives `library:changed`. */
export const VJ_LIBRARY_ROOM = 'vj:library';

/** Refusals a client can repeat at no cost or that a busy stage meets in normal use; they get no log line, so a flood cannot fill the log. */
const UNLOGGED_REFUSALS: ReadonlySet<VjSocketErrorCode> =
  new Set<VjSocketErrorCode>([
    'vj_not_attached',
    'vj_wrong_role',
    'vj_rate_limited',
    'vj_stale_command',
    'vj_clip_excluded',
    'vj_clip_not_favorite',
    'vj_stale_setlist',
    'vj_no_screens_connected',
    'vj_setlist_flash_unconfirmed',
  ]);

/** Library change kinds whose stage effect needs the follow read (item ids
 *  and Loop) of each active set list they name (sequences 5.9). */
const SETLIST_FOLLOW_CHANGE_KINDS: ReadonlySet<VjLibraryChange['kind']> =
  new Set<VjLibraryChange['kind']>([
    'setlist_items_changed',
    'scene_deleted',
    'clip_deleted',
    'setlist_updated',
  ]);

/** An ack before `serverNow` is stamped: a success carries its own fields,
 *  a refusal is the `vjAckFailure` one. */
type VjUnstampedAck<Success extends object> =
  ({ ok: true } & Success) | VjAckFailure;

/** A `session:reauth` ack before `serverNow` is stamped. */
type VjUnstampedReauthAck =
  { ok: true; exp: number } | { ok: false; code: VjWsTransportCode };

/**
 * Stamps the server clock on an ack right before it leaves (contract 7.2),
 * overwriting the time `vjAckFailure` read when the refusal was built, so a
 * refusal that waited in the command queue still reports the time it left.
 */
export function withServerNow<Ack extends object>(
  ack: Ack,
): Ack & { serverNow: number } {
  return { ...ack, serverNow: Date.now() };
}

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
  /** Epoch ms of the last read that found VJ access (an active Admin or an
   *  active `vj_operator` holder). */
  accessCheckedAt?: number;
  /** The access read in flight, shared by frames that arrive while it runs. */
  pendingAccessCheck?: Promise<VjAccess>;
  /** Set once a read found no VJ access; the drop is already scheduled. */
  hasLostVjAccess?: boolean;
  /** Whether the last access read admitted this socket through the
   *  `vj_operator` grant (a caller who is not an Admin). A lockdown drops
   *  these sockets. */
  isAdmittedByGrant?: boolean;
  /** The tail of this socket's command queue: every `stage:*` command and
   *  `screen:advance` runs after the one before it settles, so a command
   *  with an existence read cannot be overtaken by a later one. Never rejects. */
  commandChain?: Promise<void>;
  /** Epoch ms a remote attach landed; the live connections list shows it. */
  attachedAt?: number;
}

type VjSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  VjSocketData
>;

/** What one access read found: no VJ access, an Admin, or a caller let in by
 *  the `vj_operator` grant alone. */
type VjAccess = 'none' | 'admin' | 'grant';

/** The verdict of the checks every frame runs before its own rules. */
type VjFrameGate =
  { userId: string; failure: null } | { userId: null; failure: VjAckFailure };

/** Whose stages a live connections read or stop reaches: every stage for an
 *  Admin, the caller's own stage for a caller let in by the `vj_operator`
 *  grant alone. */
export interface VjLiveScope {
  callerUserId: string;
  isAdmin: boolean;
}

/** A single stop: the counts, or the refusal code the route answers. */
export type VjLiveStopOutcome =
  | { refusal: null; stopped: VjLiveStoppedDTO }
  | {
      refusal: Extract<
        VjRefusalCode,
        'VJ_CONNECTION_NOT_FOUND' | 'VJ_CONNECTION_NOT_YOURS'
      >;
      stopped: null;
    };

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

/** The socket code a failed Loop save answers (sequences 5.6): a set list
 *  the write no longer found answers `vj_setlist_not_found`; every other
 *  failure `vj_server_error`. */
function setlistWriteRefusalOf(error: unknown): VjRemoteWriteRefusal {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (isRecord(body) && body.code === 'VJ_SETLIST_NOT_FOUND') {
      return 'vj_setlist_not_found';
    }
  }
  return 'vj_server_error';
}

/** The own enumerable fields of a validated payload as a plain record for `VjStageService`. */
function toPayloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {};
  return { ...(payload as Record<string, unknown>) };
}

/** Reads the lost-access flag afresh, so a check after an await is not narrowed by one before it. */
function hasLostVjAccessNow(data: VjSocketData): boolean {
  return data.hasLostVjAccess === true;
}

/** The `exception` frame sent before a socket whose caller has no VJ access
 *  (neither an active Admin nor an active `vj_operator` holder) is dropped. */
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
  /** One trailing `screens:update` timer per stage owner's user id. */
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
  private readonly mixLimiter = new TokenBucketLimiter(VJ_MIX_RATE_LIMIT);
  private readonly effectsLimiter = new TokenBucketLimiter(
    VJ_EFFECTS_RATE_LIMIT,
  );
  private readonly identifyLimiter = new TokenBucketLimiter(
    IDENTIFY_RATE_LIMIT,
  );
  private readonly renderModeLimiter = new TokenBucketLimiter(
    RENDER_MODE_RATE_LIMIT,
  );
  private readonly clockSyncLimiter = new TokenBucketLimiter(
    CLOCK_SYNC_RATE_LIMIT,
  );

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly stages: VjStageService,
    private readonly reads: VjStageReadsService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    private readonly platformSettings: PlatformSettingsService,
    private readonly setlists: VjSetlistService,
  ) {}

  /** The stage service broadcasts its timer frames (strobe, overlay and
   *  countdown) through this binding, queued on the next tick behind any
   *  command frame already waiting so revisions reach clients in order. */
  afterInit(): void {
    this.stages.bindBroadcaster({
      broadcastState: (adminUserId: string, frame: VjStageFrame) => {
        this.broadcastOnNextTick(adminUserId, frame);
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
    this.mixLimiter.clear(client.id);
    this.effectsLimiter.clear(client.id);
    this.identifyLimiter.clear(client.id);
    this.renderModeLimiter.clear(client.id);
    this.clockSyncLimiter.clear(client.id);
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
   * Lockdown is the platform kill switch. An Admin always passes it, so only
   * the sockets the `vj_operator` grant admitted get `PLATFORM_LOCKED` and
   * are dropped; the handshake decides who may come back (a moderator holding
   * the grant, when the lockdown allows moderators).
   */
  @OnEvent(PLATFORM_LOCKDOWN_ENABLED)
  async handleLockdownEnabled(): Promise<void> {
    const grantSockets = [...(this.namespace?.sockets.values() ?? [])].filter(
      (socket) => (socket as VjSocket).data.isAdmittedByGrant === true,
    );
    if (grantSockets.length === 0) return;
    this.logger.warn(
      `Lockdown enabled: disconnecting ${grantSockets.length} VJ operator sockets`,
    );
    let lockdownMessage = DEFAULT_LOCKDOWN_MESSAGE;
    try {
      lockdownMessage =
        (await this.platformSettings.get()).lockdownMessage ||
        DEFAULT_LOCKDOWN_MESSAGE;
    } catch {
      // The drop matters more than the wording; the default copy stands in.
    }
    const frame = buildChatWsErrorFrame('PLATFORM_LOCKED', lockdownMessage);
    for (const socket of grantSockets) {
      socket.emit('exception', frame);
      socket.disconnect(true);
    }
  }

  /**
   * Relays a committed library change to every attached VJ socket, then
   * broadcasts the `stage:state` frame of each stage the change touched
   * (contract 7.10) on the next tick, queued behind any command frame
   * already waiting so revisions reach clients in order. Only the eight
   * contract fields are relayed. A set list items change or update, a scene
   * delete or a clip delete first reads the follow read (item ids and Loop)
   * of each set list it names that a stage has active (sequences 5.9), so
   * every stage with that set list active follows; a failed read logs the
   * kind and the ids only and the change applies with the reads that came
   * back. Never rejects.
   */
  @OnEvent(VJ_LIBRARY_CHANGED)
  async handleLibraryChanged(change: VjLibraryChange): Promise<void> {
    const relayed: VjLibraryChange = {
      kind: change.kind,
      packId: change.packId,
      clipId: change.clipId,
      packIds: [...change.packIds],
      sceneId: change.sceneId,
      setlistId: change.setlistId,
      setlistIds: [...change.setlistIds],
      eventId: change.eventId,
    };
    this.namespace?.to(VJ_LIBRARY_ROOM).emit('library:changed', relayed);
    try {
      const setlistReads = SETLIST_FOLLOW_CHANGE_KINDS.has(relayed.kind)
        ? await this.readActiveSetlistFollows(relayed)
        : new Map<string, VjSetlistFollowRead | null>();
      for (const { adminUserId, frame } of this.stages.applyLibraryChange(
        relayed,
        Date.now(),
        setlistReads,
      )) {
        this.broadcastOnNextTick(adminUserId, frame);
      }
    } catch {
      this.logger.error(`VJ library change apply failed: ${relayed.kind}`);
    }
  }

  @SubscribeMessage('session:reauth')
  async handleReauth(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjReauthPayloadDto,
  ): Promise<VjReauthAck> {
    return withServerNow(await this.reauth(client, payload));
  }

  /** `clock:sync` (contract 7.3): any admitted socket, attached or not, gets
   *  the server clock. It runs outside the command queue (note 17), so a slow
   *  command never inflates the round trip the clock sample measures. */
  @SubscribeMessage('clock:sync')
  async handleClockSync(
    @ConnectedSocket() client: VjSocket,
    // Declared so the pipe refuses any key; the frame carries nothing.
    @MessageBody() _payload: VjClockSyncPayloadDto,
  ): Promise<VjAck<object>> {
    const gate = await this.frameGate(
      client,
      'clock:sync',
      this.clockSyncLimiter,
      null,
    );
    if (gate.failure !== null) return withServerNow(gate.failure);
    return withServerNow<{ ok: true }>({ ok: true });
  }

  /** `screen:identify` from a remote: each target screen draws its number.
   *  Outside the command queue (note 17); it changes no state. */
  @SubscribeMessage('screen:identify')
  async handleScreenIdentify(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjScreenIdentifyPayloadDto,
  ): Promise<VjAck<{ identifiedCount: number }>> {
    const frame = 'screen:identify';
    const gate = await this.frameGate(
      client,
      frame,
      this.identifyLimiter,
      'remote',
    );
    if (gate.failure !== null) return withServerNow(gate.failure);
    const identified = this.stages.identifyTargets(
      gate.userId,
      payload.screenId,
    );
    if (identified.failure !== null) {
      return withServerNow(this.refusal(frame, client, identified.failure));
    }
    const { targets } = identified;
    this.emitOnNextTick(gate.userId, () => {
      for (const target of targets) {
        const identifyFrame: VjScreenIdentifyFrame = {
          number: target.number,
          durationMs: VJ_LIMITS.identifyDurationMs,
        };
        this.namespace?.to(target.socketId).emit(frame, identifyFrame);
      }
    });
    return withServerNow<{ ok: true; identifiedCount: number }>({
      ok: true,
      identifiedCount: targets.length,
    });
  }

  /** `screens:setRenderMode` from a remote: every connected screen gets
   *  `screen:renderMode`. Outside the command queue (note 17); the stage
   *  stores nothing, so a screen that attaches later starts on its own default. */
  @SubscribeMessage('screens:setRenderMode')
  async handleSetRenderMode(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetRenderModePayloadDto,
  ): Promise<VjAck<{ reachedCount: number }>> {
    const frame = 'screens:setRenderMode';
    const gate = await this.frameGate(
      client,
      frame,
      this.renderModeLimiter,
      'remote',
    );
    if (gate.failure !== null) return withServerNow(gate.failure);
    const { mode } = payload;
    if (!isOneOf<VjRenderMode>(VJ_RENDER_MODES, mode)) {
      return withServerNow(
        this.refusal(frame, client, vjAckFailure('vj_render_mode_invalid')),
      );
    }
    const reached = this.stages.renderModeTargets(gate.userId);
    if (reached.failure !== null) {
      return withServerNow(this.refusal(frame, client, reached.failure));
    }
    const { targets } = reached;
    this.emitOnNextTick(gate.userId, () => {
      for (const target of targets) {
        const renderModeFrame: VjScreenRenderModeFrame = { mode };
        this.namespace
          ?.to(target.socketId)
          .emit('screen:renderMode', renderModeFrame);
      }
    });
    return withServerNow<{ ok: true; reachedCount: number }>({
      ok: true,
      reachedCount: targets.length,
    });
  }

  @SubscribeMessage('vj:attach')
  async handleAttach(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjAttachPayloadDto,
  ): Promise<VjAck<VjAttachSuccess>> {
    return withServerNow(await this.attach(client, payload));
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

  @SubscribeMessage('stage:goGenerator')
  handleGoGenerator(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjGoGeneratorPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:goGenerator', payload);
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

  @SubscribeMessage('stage:setTempo')
  handleSetTempo(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetTempoPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setTempo', payload);
  }

  @SubscribeMessage('stage:setMix')
  handleSetMix(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetMixPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setMix', payload);
  }

  @SubscribeMessage('stage:swapMix')
  handleSwapMix(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSwapMixPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:swapMix', payload);
  }

  @SubscribeMessage('stage:setScreenOverride')
  handleSetScreenOverride(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetScreenOverridePayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setScreenOverride', payload);
  }

  @SubscribeMessage('stage:resetLook')
  handleResetLook(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjResetLookPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:resetLook', payload);
  }

  @SubscribeMessage('stage:recallScene')
  handleRecallScene(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjRecallScenePayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:recallScene', payload);
  }

  @SubscribeMessage('stage:setlistSelect')
  handleSetlistSelect(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetlistSelectPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setlistSelect', payload);
  }

  @SubscribeMessage('stage:setlistNext')
  handleSetlistNext(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetlistStepPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setlistNext', payload);
  }

  @SubscribeMessage('stage:setlistPrevious')
  handleSetlistPrevious(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetlistStepPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setlistPrevious', payload);
  }

  @SubscribeMessage('stage:setlistSetPlaying')
  handleSetlistSetPlaying(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetlistSetPlayingPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setlistSetPlaying', payload);
  }

  /** `stage:setlistSetLooping` (sequences 5.6): Loop is saved on the active
   *  set list first, then the playback change lands. */
  @SubscribeMessage('stage:setlistSetLooping')
  async handleSetlistSetLooping(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetlistSetLoopingPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    const name: VjRemoteCommandName = 'stage:setlistSetLooping';
    const ack = await this.queueMeteredFrame(
      client,
      name,
      this.commandLimiterOf(name),
      async () => {
        const gate = await this.frameGate(client, name, null, 'remote');
        if (gate.failure !== null) return gate.failure;
        const userId = gate.userId;
        return this.landOutcome(client, userId, name, () =>
          this.saveLoopingAndRun(userId, toPayloadRecord(payload)),
        );
      },
    );
    return withServerNow(ack);
  }

  @SubscribeMessage('stage:setCountdown')
  handleSetCountdown(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetCountdownPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setCountdown', payload);
  }

  @SubscribeMessage('stage:setLogo')
  handleSetLogo(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetLogoPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setLogo', payload);
  }

  @SubscribeMessage('stage:setEventCard')
  handleSetEventCard(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjSetEventCardPayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    return this.runRemoteCommand(client, 'stage:setEventCard', payload);
  }

  /** The lead screen's shuffle report: the stage's checks, its one
   *  `packClip` read, then the shuffle step. */
  @SubscribeMessage('screen:advance')
  async handleScreenAdvance(
    @ConnectedSocket() client: VjSocket,
    @MessageBody() payload: VjScreenAdvancePayloadDto,
  ): Promise<VjAck<VjCommandSuccess>> {
    const frame = 'screen:advance';
    const ack = await this.queueMeteredFrame(
      client,
      frame,
      this.advanceLimiter,
      async () => {
        const gate = await this.frameGate(client, frame, null, 'screen');
        if (gate.failure !== null) return gate.failure;
        return this.landOutcome(client, gate.userId, frame, () =>
          this.stages.runScreenAdvance(
            gate.userId,
            client.id,
            toPayloadRecord(payload),
          ),
        );
      },
    );
    return withServerNow(ack);
  }

  /** A screen's status report (contract 7.9); takes no ack, so every refusal
   *  drops it silently. A lead's mic report may adopt the tempo, broadcast
   *  as a `mic_tempo` frame. */
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
    let update: ReturnType<VjStageService['updateScreenStatus']>;
    try {
      update = this.stages.updateScreenStatus(
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
    this.broadcastOnNextTick(gate.userId, update.frame);
    if (update.isStored) this.scheduleScreensUpdate(gate.userId);
  }

  /** The reauth checks; the handler stamps `serverNow` on the answer. */
  private async reauth(
    client: VjSocket,
    payload: VjReauthPayloadDto,
  ): Promise<VjUnstampedReauthAck> {
    const userId = client.data.userId ?? (await client.data.admission) ?? null;
    if (userId === null) return { ok: false, code: 'UNAUTHORIZED' };
    if (!this.reauthLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    let exp: number;
    let familyId: string | undefined;
    let access: VjAccess;
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
      access = await this.accessOf(user);
      if (access === 'none') {
        throw new ChatWsException('FORBIDDEN', VJ_NOT_ADMIN_MESSAGE);
      }
      await this.assertNotLockedOut(user.role);
      await this.assertSessionLive(record.sessionId);
      exp = record.exp;
      familyId = record.sessionId;
    } catch (error: unknown) {
      const code: ChatWsErrorCode =
        error instanceof ChatWsException ? error.code : 'SERVER_ERROR';
      this.logger.debug(
        `VJ session:reauth refused: ${code} user ${userId} socket ${client.id}`,
      );
      if (code === 'FORBIDDEN') {
        this.dropForLostVjAccess(client);
      } else if (
        code === 'PLATFORM_LOCKED' &&
        error instanceof ChatWsException
      ) {
        this.refuseHandshake(client, error.getError() as ChatWsErrorFrame);
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
    client.data.accessCheckedAt = checkStartedAt;
    client.data.isAdmittedByGrant = access === 'grant';
    if (!this.scheduleTokenExpiry(client, exp)) {
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    return { ok: true, exp };
  }

  /**
   * The attach checks in contract 7.1 order: the common checks,
   * `vj_already_attached`, then `vj_client_outdated` for any
   * `contractVersion` other than `VJ_CONTRACT_VERSION`, then the role's own.
   * An outdated client never claims the role, so nothing stays claimed.
   */
  private async attach(
    client: VjSocket,
    payload: VjAttachPayloadDto,
  ): Promise<VjUnstampedAck<VjAttachSuccess>> {
    const frame = 'vj:attach';
    const gate = await this.frameGate(client, frame, this.attachLimiter, null);
    if (gate.failure !== null) return gate.failure;
    if (client.data.role !== undefined) {
      return this.refusal(frame, client, vjAckFailure('vj_already_attached'));
    }
    if (payload.contractVersion !== VJ_CONTRACT_VERSION) {
      return this.refusal(frame, client, vjAckFailure('vj_client_outdated'));
    }
    // Claimed in the same synchronous segment as the checks above, so two
    // attach frames in a burst cannot both pass them.
    client.data.role = payload.role;
    let ack: VjUnstampedAck<VjAttachSuccess>;
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
      const access = await this.accessOf(user);
      if (access === 'none') {
        this.logger.debug(
          `VJ handshake refused: FORBIDDEN vj_not_admin (no Admin role or VJ operator grant) socket ${client.id}`,
        );
        this.refuseHandshake(client, notAdminFrame());
        return null;
      }
      await this.assertNotLockedOut(user.role);
      await this.assertSessionLive(claims.sid);
      // The client may have gone while the checks above awaited.
      if (!client.connected) return null;
      client.data.userId = user.id;
      client.data.exp = claims.exp;
      client.data.familyId = claims.sid;
      client.data.accessCheckedAt = checkStartedAt;
      client.data.isAdmittedByGrant = access === 'grant';
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
   * the frame's bucket, the VJ access recheck, then for every frame but attach
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
    const accessRefusal = await this.recheckVjAccess(client, userId);
    if (accessRefusal !== null) return deny(accessRefusal);
    if (expectedRole !== null) {
      if (client.data.isAttached !== true) return deny('vj_not_attached');
      if (client.data.role !== expectedRole) return deny('vj_wrong_role');
    }
    return { userId, failure: null };
  }

  /**
   * Null while the caller is an active Admin or an active `vj_operator`
   * holder. The verdict is trusted for `VJ_ROLE_RECHECK_MS`; an older one
   * reads `users.role, users.status` (and, for a caller who is not an Admin,
   * their `vj_operator` grant) first, shared by every frame that arrives
   * while the read runs. A caller who lost the role or whose grant was
   * revoked gets `vj_not_admin` and is dropped after the ack.
   */
  private async recheckVjAccess(
    client: VjSocket,
    userId: string,
  ): Promise<VjSocketErrorCode | null> {
    if (client.data.hasLostVjAccess === true) return 'vj_not_admin';
    const checkStartedAt = Date.now();
    const checkedAt = client.data.accessCheckedAt;
    if (
      checkedAt !== undefined &&
      checkStartedAt - checkedAt < VJ_ROLE_RECHECK_MS
    ) {
      return null;
    }
    let access: VjAccess;
    try {
      client.data.pendingAccessCheck ??= this.readHasVjAccess(userId).finally(
        () => {
          client.data.pendingAccessCheck = undefined;
        },
      );
      access = await client.data.pendingAccessCheck;
    } catch {
      return 'vj_server_error';
    }
    // A `session:reauth` that found the access gone while this read awaited
    // has already scheduled the drop; this frame must not apply.
    if (hasLostVjAccessNow(client.data)) return 'vj_not_admin';
    if (access === 'none') {
      this.dropForLostVjAccess(client);
      return 'vj_not_admin';
    }
    client.data.isAdmittedByGrant = access === 'grant';
    client.data.accessCheckedAt = Math.max(
      client.data.accessCheckedAt ?? 0,
      checkStartedAt,
    );
    return null;
  }

  /** The live access of a user id: their row, then (when they are not an
   *  Admin) their `vj_operator` grant. An inactive or missing row has none. */
  private async readHasVjAccess(userId: string): Promise<VjAccess> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
    if (user === null || user.status !== UserStatus.Active) return 'none';
    return this.accessOf(user);
  }

  /** An active row's VJ access: Admin on the role alone (no query), anyone
   *  else through the `vj_operator` grant (one indexed lookup). */
  private async accessOf(user: Pick<User, 'id' | 'role'>): Promise<VjAccess> {
    if (user.role === UserRole.Admin) return 'admin';
    const hasGrant = await isAdminOrHoldsStaffRole(
      this.staffRoles,
      { userId: user.id, role: user.role },
      VJ_STAFF_ROLES,
    );
    return hasGrant ? 'grant' : 'none';
  }

  /**
   * The `PlatformLockdownGuard` predicate: an Admin passes, a moderator when
   * the lockdown allows moderators, and anyone else (a member holding the
   * `vj_operator` grant) gets `PLATFORM_LOCKED` with the lockdown message.
   * Settings come from an in-process cache, so an unlocked platform pays
   * nothing here.
   */
  private async assertNotLockedOut(role: UserRole): Promise<void> {
    if (role === UserRole.Admin) return;
    const settings = await this.platformSettings.get();
    if (!settings.lockdownEnabled) return;
    if (role === UserRole.Moderator && settings.lockdownAllowsModerators) {
      return;
    }
    throw new ChatWsException(
      'PLATFORM_LOCKED',
      settings.lockdownMessage || DEFAULT_LOCKDOWN_MESSAGE,
    );
  }

  /** The `exception FORBIDDEN vj_not_admin` frame and the drop, on the next tick so the frame's ack leaves first. */
  private dropForLostVjAccess(client: VjSocket): void {
    // Scheduled once per socket, however many frames find the access gone.
    if (client.data.hasLostVjAccess === true) return;
    client.data.hasLostVjAccess = true;
    setImmediate(() => {
      if (!client.connected) return;
      client.emit('exception', notAdminFrame());
      client.disconnect(true);
    });
  }

  /**
   * A screen attach: the restore reads (contract 7.13) only while the stage
   * would adopt a restore, then the stage rules, the rooms, the replaced
   * socket, the ack, and on the next tick `stage:state`, `screen:role` and
   * `screens:update`. A restore goes to the whole stage with `applyAt: null`;
   * any other attach frame carries the pending `applyAt` to this socket. A
   * malformed screen id answers vj_screen_id_invalid before any read.
   */
  private async attachScreen(
    client: VjSocket,
    userId: string,
    payload: VjAttachPayloadDto,
  ): Promise<VjUnstampedAck<VjAttachSuccess>> {
    const frame = 'vj:attach';
    if (!isUuidString(payload.screenId)) {
      return this.refusal(frame, client, vjAckFailure('vj_screen_id_invalid'));
    }
    let restoreReads: VjLookupResults | null = null;
    if (this.stages.shouldAdoptRestore(userId)) {
      const lookups = this.stages.restoreLookupsOf(
        payload.restoreState,
        Date.now(),
      );
      try {
        restoreReads =
          lookups.length === 0
            ? EMPTY_VJ_LOOKUP_RESULTS
            : await resolveVjLookups(this.reads, lookups);
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
        restoreReads,
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
    this.emitScreenAttachFrames(client, userId, outcome);
    return {
      ok: true,
      role: 'screen',
      connectionExpiresAt: (client.data.exp ?? 0) * 1000,
      stageEpoch: outcome.state.stageEpoch,
      isRestored: outcome.isRestored,
      isLead: outcome.isLead,
      screenNumber: outcome.screenNumber,
    };
  }

  /** The frames after a screen attach's ack, on the next tick. */
  private emitScreenAttachFrames(
    client: VjSocket,
    userId: string,
    outcome: Extract<VjScreenAttachOutcome, { ok: true }>,
  ): void {
    const promotedSocketId = outcome.leadChange?.promotedSocketId ?? null;
    this.emitOnNextTick(userId, () => {
      const stageFrame: VjStageFrame = outcome.isRestored
        ? {
            state: this.stages.getState(userId) ?? outcome.state,
            cause: 'restore',
            sourceClientId: null,
            applyAt: null,
          }
        : this.liveAttachFrame(userId, outcome);
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
  }

  /** A remote attach: its rooms, the ack, then `stage:state` (with the
   *  pending `applyAt`) and the screen list to this socket alone. */
  private async attachRemote(
    client: VjSocket,
    userId: string,
  ): Promise<VjUnstampedAck<VjAttachSuccess>> {
    // A socket that left while the gate awaited must not join the stage.
    if (!client.connected) return vjAckFailure('vj_not_attached');
    const attachedAt = Date.now();
    const attached = this.stages.attachRemote(userId, client.id, attachedAt);
    client.data.isAttached = true;
    client.data.attachedAt = attachedAt;
    await client.join([
      vjStageRoomName(userId),
      vjRemotesRoomName(userId),
      VJ_LIBRARY_ROOM,
    ]);
    this.emitOnNextTick(userId, () => {
      if (!client.connected) return;
      client.emit('stage:state', this.liveAttachFrame(userId, attached));
      client.emit('screens:update', {
        screens: this.stages.listScreens(userId, Date.now()),
      });
    });
    return {
      ok: true,
      role: 'remote',
      connectionExpiresAt: (client.data.exp ?? 0) * 1000,
      stageEpoch: attached.state.stageEpoch,
      isRestored: false,
      isLead: null,
      screenNumber: null,
    };
  }

  /** An attach's `stage:state` frame, built on the next tick: the live state
   *  with its pending `applyAt` read at the same moment (contract 7.4), or
   *  the attach-time pair when the stage is gone. */
  private liveAttachFrame(
    userId: string,
    attached: { state: VjStageState; applyAt: number | null },
  ): VjStageFrame {
    const liveState = this.stages.getState(userId);
    return {
      state: liveState ?? attached.state,
      cause: 'attach',
      sourceClientId: null,
      applyAt:
        liveState === null
          ? attached.applyAt
          : vjAttachApplyAt(this.stages.getPendingApplyAt(userId), Date.now()),
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
    this.logger.debug(`VJ screen replaced: user ${userId} socket ${socketId}`);
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

  /**
   * Every remote command: the frame's bucket (`stage:setMix` and
   * `stage:setEffects` have their own, every other `stage:*` frame shares
   * the command bucket), the common checks, then the stage service runs the
   * client id, stale and field rules, reads the command's lookups and lands
   * it. The frame goes to the whole stage on the next tick, after the ack.
   * Commands of one socket run in arrival order.
   */
  private async runRemoteCommand(
    client: VjSocket,
    name: VjRemoteCommandName,
    payload: unknown,
  ): Promise<VjAck<VjCommandSuccess>> {
    const ack = await this.queueMeteredFrame(
      client,
      name,
      this.commandLimiterOf(name),
      async () => {
        const gate = await this.frameGate(client, name, null, 'remote');
        if (gate.failure !== null) return gate.failure;
        return this.landOutcome(client, gate.userId, name, () =>
          this.stages.runRemoteCommand(
            gate.userId,
            name,
            toPayloadRecord(payload),
          ),
        );
      },
    );
    return withServerNow(ack);
  }

  /**
   * The stage side of `stage:setlistSetLooping` (sequences 5.6): the field
   * rules and `vj_setlist_none` run first with nothing written; a refusal
   * there answers through `runRemoteCommand`, which records the sequence and
   * answers the same code. Then Loop is saved through the set list service
   * (it emits `setlist_updated`, which every other stage with this set list
   * active follows); a failed save answers `vj_setlist_not_found` or
   * `vj_server_error` with the sequence recorded. When another remote
   * stopped or switched the sequence while the save ran, nothing lands and
   * it answers `vj_stale_setlist` with the state, the sequence recorded.
   * Otherwise the Loop the save answered (the row as stored) lands the
   * playback change with cause `command`.
   */
  private async saveLoopingAndRun(
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<VjStageOutcome> {
    const name: VjRemoteCommandName = 'stage:setlistSetLooping';
    const prepared = this.stages.prepareRemoteCommand(
      userId,
      name,
      payload,
      Date.now(),
    );
    const activeSetlistId =
      this.stages.getState(userId)?.activeSetlistId ?? null;
    if (prepared.failure !== null || activeSetlistId === null) {
      return this.stages.runRemoteCommand(userId, name, payload);
    }
    let savedIsLooping: boolean;
    try {
      const saved = await this.setlists.updateSetlist(activeSetlistId, {
        isLooping: payload.isLooping,
      });
      savedIsLooping = saved.isLooping;
    } catch (error) {
      return this.stages.refuseRemoteWrite(
        userId,
        payload,
        setlistWriteRefusalOf(error),
      );
    }
    // Another remote may have stopped or switched the sequence while the
    // save ran: Loop then landed on a set list this stage no longer plays.
    const activeAfterSave =
      this.stages.getState(userId)?.activeSetlistId ?? null;
    if (activeAfterSave !== activeSetlistId) {
      return this.stages.refuseRemoteWrite(userId, payload, 'vj_stale_setlist');
    }
    // The row's Loop after the save, so the switch and the row agree.
    return this.stages.runRemoteCommand(userId, name, {
      ...payload,
      isLooping: savedIsLooping,
    });
  }

  /** The bucket a remote command is metered on (contract 7.12). */
  private commandLimiterOf(name: VjRemoteCommandName): TokenBucketLimiter {
    if (name === 'stage:setMix') return this.mixLimiter;
    if (name === 'stage:setEffects') return this.effectsLimiter;
    return this.commandLimiter;
  }

  /**
   * Meters a frame on arrival, then queues `work` behind every command this
   * socket sent before it. A frame past its bucket answers
   * `vj_rate_limited` at once and never joins the queue, so a flood cannot
   * grow it. Without the queue a command that awaits a lookup read (a
   * `stage:goClip`) could be overtaken by a later one that reads nothing (a
   * fade slider frame), which records the higher sequence and turns the
   * earlier tap into `vj_stale_command`. A failed command never blocks the
   * next one.
   */
  private queueMeteredFrame<Success extends object>(
    client: VjSocket,
    frame: VjClientFrameName,
    limiter: TokenBucketLimiter,
    work: () => Promise<VjUnstampedAck<Success>>,
  ): Promise<VjUnstampedAck<Success>> {
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
   * Runs a stage step and answers its ack: the refusal (logged by code), or
   * the success with the frame broadcast on the next tick. A stage step that
   * throws or rejects answers `vj_server_error`; the log carries the code and
   * ids only.
   */
  private async landOutcome(
    client: VjSocket,
    userId: string,
    frame: VjClientFrameName,
    runStage: () => Promise<VjStageOutcome>,
  ): Promise<VjUnstampedAck<VjCommandSuccess>> {
    let outcome: VjStageOutcome;
    try {
      outcome = await runStage();
    } catch {
      return this.refusal(frame, client, vjAckFailure('vj_server_error'));
    }
    if (!outcome.ok) return this.refusal(frame, client, outcome.failure);
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

  /** Runs a frame builder on the next tick, after the handler's ack; a builder that throws logs the stage owner's id only. */
  private emitOnNextTick(adminUserId: string, emitFrames: () => void): void {
    setImmediate(() => {
      try {
        emitFrames();
      } catch {
        this.logger.error(`VJ frame emit failed: user ${adminUserId}`);
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
        `VJ ${frame} refused: ${failure.code} user ${client.data.userId ?? 'none'} socket ${client.id}`,
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
      this.mixLimiter,
      this.effectsLimiter,
      this.identifyLimiter,
      this.renderModeLimiter,
      this.clockSyncLimiter,
    ];
  }

  /**
   * The follow read (item ids and Loop) of each set list the change names
   * that some stage has active, read in parallel and keyed by lowercased id;
   * null for a set list that is gone. A failed read leaves its id out of the
   * map and logs the change kind and the set list ids only.
   */
  private async readActiveSetlistFollows(
    change: VjLibraryChange,
  ): Promise<Map<string, VjSetlistFollowRead | null>> {
    const activeSetlistIds = this.stages.activeSetlistIdsAmong(
      change.setlistIds,
    );
    const follows = new Map<string, VjSetlistFollowRead | null>();
    const settled = await Promise.allSettled(
      activeSetlistIds.map((setlistId) =>
        this.reads.readSetlistFollow(setlistId),
      ),
    );
    const failedSetlistIds: string[] = [];
    settled.forEach((result, position) => {
      const setlistId = activeSetlistIds[position];
      if (setlistId === undefined) return;
      if (result.status === 'fulfilled') {
        follows.set(setlistId, result.value);
      } else {
        failedSetlistIds.push(setlistId);
      }
    });
    if (failedSetlistIds.length > 0) {
      this.logger.error(
        `VJ set list follow read failed: ${change.kind} set lists ${failedSetlistIds.join(',')}`,
      );
    }
    return follows;
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

  /**
   * The live connections in scope for `GET admin/vj/live`: every stage in
   * memory with an attached screen or remote, read from the stage service
   * and the live sockets, with the owner names in one profiles read (none
   * when no stage is listed) and the count of idle stages. The snapshots and
   * the idle count are read together before the profiles read awaits, so
   * both describe one moment.
   */
  async listLiveConnections(scope: VjLiveScope): Promise<VjLiveDTO> {
    const ownerScope = scope.isAdmin ? null : scope.callerUserId;
    const snapshots = this.liveStageSnapshots(ownerScope);
    const idleStageCount = this.stages.idleStageCount(ownerScope);
    const listedOwnerIds = snapshots
      .filter((stage) => stage.screens.length + stage.remotes.length > 0)
      .map((stage) => stage.ownerUserId);
    const profiles = await readVjCreatorProfiles(
      this.users.manager,
      listedOwnerIds,
    );
    const displayNames = new Map<string, string>();
    for (const ownerUserId of listedOwnerIds) {
      displayNames.set(
        ownerUserId,
        toVjCreator(ownerUserId, profiles)?.displayName ?? '',
      );
    }
    return toVjLiveDTO(
      snapshots,
      displayNames,
      scope.callerUserId,
      idleStageCount,
    );
  }

  /**
   * Stops one live `/vj` socket: `exception BAD_REQUEST vj_stopped`, then the
   * drop, as a replaced screen gets. The normal disconnect path then detaches
   * it (lead promotion, `screens:update` to the remotes). A socket id with no
   * live admitted socket answers `VJ_CONNECTION_NOT_FOUND`; a caller let in
   * by the grant alone who names another owner's socket answers
   * `VJ_CONNECTION_NOT_YOURS`.
   */
  stopLiveConnection(
    scope: VjLiveScope,
    connectionId: string,
  ): VjLiveStopOutcome {
    const socket = this.liveSocketOf(connectionId);
    const ownerUserId = socket?.data.userId;
    if (socket === null || ownerUserId === undefined) {
      return { refusal: 'VJ_CONNECTION_NOT_FOUND', stopped: null };
    }
    if (!scope.isAdmin && ownerUserId !== scope.callerUserId) {
      return { refusal: 'VJ_CONNECTION_NOT_YOURS', stopped: null };
    }
    const stopped = this.stopSockets([socket]);
    this.logger.log(
      `VJ connection stopped: user ${ownerUserId} socket ${socket.id} by ${scope.callerUserId}`,
    );
    return { refusal: null, stopped };
  }

  /**
   * Stops everything in scope: every `/vj` socket in it, attached or not,
   * gets `vj_stopped` and is dropped, then every stage in scope (attached or
   * idle) is dropped with its timers, and its trailing `screens:update`
   * timer is cleared. A socket left out because its handshake is still
   * running gets the same stop once its admission lands on an owner in
   * scope (see `stopWhenAdmitted`); the answer does not wait for those
   * handshakes and leaves them out of the counts.
   */
  stopEverything(scope: VjLiveScope): VjLiveStoppedDTO {
    const ownerScope = scope.isAdmin ? null : scope.callerUserId;
    const namespaceSockets = [...(this.namespace?.sockets.values() ?? [])].map(
      (socket) => socket as VjSocket,
    );
    const sockets = namespaceSockets.filter(
      (socket) => ownerScope === null || socket.data.userId === ownerScope,
    );
    const admittingSockets = namespaceSockets.filter(
      (socket) =>
        !sockets.includes(socket) &&
        socket.data.userId === undefined &&
        socket.data.admission !== undefined,
    );
    const stopped = this.stopSockets(sockets);
    for (const socket of admittingSockets) {
      this.stopWhenAdmitted(socket, ownerScope, scope.callerUserId);
    }
    const ownerUserIds = this.stages
      .liveStages(ownerScope)
      .map((stage) => stage.adminUserId);
    for (const ownerUserId of ownerUserIds) {
      this.stages.dropStage(ownerUserId);
      this.clearScreensUpdateTimer(ownerUserId);
    }
    if (ownerScope !== null) this.clearScreensUpdateTimer(ownerScope);
    this.logger.log(
      `VJ stopped everything: ${stopped.stoppedScreenCount} screens, ${stopped.stoppedRemoteCount} remotes, ${ownerUserIds.length} stages by ${scope.callerUserId}`,
    );
    return stopped;
  }

  /**
   * The late half of a stop everything for a socket whose handshake was still
   * running: once its admission lands on an owner in scope (any owner when
   * `ownerScope` is null) and the socket is still connected, it gets the same
   * `vj_stopped` drop. When it had attached meanwhile and so brought the
   * owner's stage back, that stage is dropped again once no socket is left
   * attached to it. Fire and forget: the caller does not await it.
   */
  private stopWhenAdmitted(
    socket: VjSocket,
    ownerScope: string | null,
    callerUserId: string,
  ): void {
    const admission = socket.data.admission;
    if (admission === undefined) return;
    admission
      .then((admittedUserId) => {
        if (admittedUserId === null) return;
        if (ownerScope !== null && admittedUserId !== ownerScope) return;
        if (!socket.connected) return;
        const hasAttached = socket.data.isAttached === true;
        this.stopSockets([socket]);
        const stage = this.stages.liveStages(admittedUserId)[0];
        const isStageEmptied =
          hasAttached &&
          stage !== undefined &&
          stage.attachedSocketIds.length === 0;
        if (isStageEmptied) {
          this.stages.dropStage(admittedUserId);
          this.clearScreensUpdateTimer(admittedUserId);
        }
        this.logger.log(
          `VJ stopped a socket admitted after stop everything: user ${admittedUserId} socket ${socket.id} by ${callerUserId}`,
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          `VJ late stop failed: socket ${socket.id} (${error instanceof Error ? error.message : 'unknown error'})`,
        );
      });
  }

  /** The stages in scope with the screens and remotes that have a live socket;
   *  a remote's time is the moment its attach landed. */
  private liveStageSnapshots(ownerScope: string | null): VjLiveStageSnapshot[] {
    return this.stages.liveStages(ownerScope).map((stage) => {
      const screenSocketIds = new Set(
        stage.screens.map((screen) => screen.socketId),
      );
      const screens = stage.screens
        .filter((screen) => this.liveSocketOf(screen.socketId) !== null)
        .map((screen) => ({
          connectionId: screen.socketId,
          number: screen.number,
          isLead: screen.isLead,
          connectedAt: screen.connectedAt,
          isFullscreen: screen.isFullscreen,
          renderer: screen.renderer,
        }));
      const remotes: VjLiveRemoteSnapshot[] = [];
      for (const socketId of stage.attachedSocketIds) {
        if (screenSocketIds.has(socketId)) continue;
        const socket = this.liveSocketOf(socketId);
        if (socket === null || socket.data.role !== 'remote') continue;
        remotes.push({
          connectionId: socketId,
          connectedAt: socket.data.attachedAt ?? socket.handshake.issued,
        });
      }
      return { ownerUserId: stage.adminUserId, screens, remotes };
    });
  }

  /** The live socket with this id, or null. */
  private liveSocketOf(socketId: string): VjSocket | null {
    const socket = this.namespace?.sockets.get(socketId);
    return socket === undefined ? null : (socket as VjSocket);
  }

  /** Sends each socket `exception BAD_REQUEST vj_stopped` and drops it, the
   *  way `dropReplacedScreen` does, and counts the screens and remotes among
   *  them by the role each claimed. */
  private stopSockets(sockets: readonly VjSocket[]): VjLiveStoppedDTO {
    const frame = buildChatWsErrorFrame(
      'BAD_REQUEST',
      VJ_STOPPED_MESSAGE,
      undefined,
      'vj_stopped',
    );
    let stoppedScreenCount = 0;
    let stoppedRemoteCount = 0;
    for (const socket of sockets) {
      if (socket.data.role === 'screen') stoppedScreenCount += 1;
      if (socket.data.role === 'remote') stoppedRemoteCount += 1;
      socket.emit('exception', frame);
      socket.disconnect(true);
    }
    return { stoppedScreenCount, stoppedRemoteCount };
  }

  /** Clears one owner's pending trailing `screens:update`. */
  private clearScreensUpdateTimer(ownerUserId: string): void {
    const timer = this.screensUpdateTimers.get(ownerUserId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.screensUpdateTimers.delete(ownerUserId);
  }
}
