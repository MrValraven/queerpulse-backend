import {
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { IsUUID } from 'class-validator';
import { parseCookie } from 'cookie';
import { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { TokenBucketLimiter } from '../chat/ws-rate-limiter';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import {
  resolveAllowedOrigins,
  resolveFrontendOrigins,
} from '../config/frontend-origins';
import {
  PLATFORM_LOCKDOWN_ENABLED,
  PlatformLockdownEnabledEvent,
} from '../platform-settings/platform-settings.events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { toMagazineEditor } from './magazine-piece-response';
import {
  DeskViewer,
  MagazineDeskPresenceService,
} from './magazine-desk-presence.service';

/** The desk-wide broadcast fires at most once per this window. */
export const DESK_VIEWERS_THROTTLE_MS = 500;

/** A socket may watch this many pieces at once: a row peek plus a few tabs. */
export const MAX_WATCHED_PIECES_PER_SOCKET = 16;

/**
 * Handshake budget per verified user, the numbers `ChatGateway` uses for its
 * own handshake (ENG-211): a burst of 10, then one every 10 seconds. Nest's
 * HTTP throttler never runs on a WebSocket upgrade, so without this any
 * signed-in member could reconnect in a loop, each attempt costing a JWT
 * verify and several indexed queries before the staff refusal.
 */
const HANDSHAKE_RATE_LIMIT = { capacity: 10, refillPerSecond: 0.1 };

/** How often fully refilled handshake buckets are reclaimed. */
const HANDSHAKE_BUCKET_SWEEP_INTERVAL_MS = 60_000;

const DESK_ROOM = 'desk';

export class PieceWatchPayload {
  @IsUUID()
  pieceId!: string;
}

/** Verified access-token claims the handshake reads. */
interface AccessTokenClaims {
  sub: string;
  status: UserStatus;
  exp: number;
  sid?: string;
}

interface DeskSocketData {
  /** Resolves to the admitted editor, or null for a refused handshake. */
  admission?: Promise<DeskViewer | null>;
  viewer?: DeskViewer;
  expiryTimer?: NodeJS.Timeout;
}

type DeskSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  DeskSocketData
>;

/**
 * Same origin allowlist as the chat gateway's handshake check: CORS never
 * runs on a raw WebSocket upgrade, so this is what stops a page on another
 * site from opening the socket with the editor's cookie. A missing `Origin`
 * is a non-browser client and is allowed, as on `/chat`.
 */
function allowDeskHandshakeOrigin(
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

/**
 * "Who is on this piece" for the magazine desk. Editors see each other's
 * avatars on a row or in the peek panel, so two people do not rework the same
 * draft at once. Staff only: the handshake admits an Admin or a holder of the
 * `magazine_editor` staff role, the same rule `StaffRolesGuard` applies to
 * every desk endpoint.
 *
 * Auth mirrors `ChatGateway.authenticate` without importing from it: the
 * `access_token` cookie (or `auth.token`), verified with the same secret and
 * pinned algorithm, the same handshake rate limit, an active membership, the
 * same platform-lockdown rule, and a live refresh-token family. The socket is
 * dropped at the token's `exp`, so a revoked staff role stops reaching
 * presence within one access TTL; the client refreshes its session,
 * reconnects, and the presence grace window covers the gap. Enabling a
 * lockdown drops every open socket at once.
 */
@WebSocketGateway({
  namespace: '/magazine-desk',
  allowRequest: allowDeskHandshakeOrigin,
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
@UsePipes(
  new ValidationPipe({
    ...VALIDATION_PIPE_OPTIONS,
    exceptionFactory: (errors) => new WsException(errors),
  }),
)
export class MagazineDeskPresenceGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer() namespace!: Namespace;
  private readonly logger = new Logger(MagazineDeskPresenceGateway.name);
  private deskBroadcastTimer: NodeJS.Timeout | null = null;
  private handshakeBucketSweepTimer: NodeJS.Timeout | null = null;
  private readonly handshakeLimiter = new TokenBucketLimiter(
    HANDSHAKE_RATE_LIMIT,
  );

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly presence: MagazineDeskPresenceService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  onModuleInit(): void {
    const timer = setInterval(
      () => this.handshakeLimiter.sweepIdle(Date.now()),
      HANDSHAKE_BUCKET_SWEEP_INTERVAL_MS,
    );
    timer.unref?.();
    this.handshakeBucketSweepTimer = timer;
  }

  /**
   * Stores the admission promise on the socket BEFORE the first await: Nest
   * calls this synchronously and binds the message handlers right after, so
   * a client that emits `desk:watch` on `connect` (before the checks below
   * resolve) has its handler wait for the verdict instead of being refused.
   */
  async handleConnection(client: DeskSocket): Promise<void> {
    client.data.admission = this.admit(client);
    await client.data.admission;
  }

  private async admit(client: DeskSocket): Promise<DeskViewer | null> {
    try {
      const claims = await this.verifyHandshakeToken(client);
      // Metered on the VERIFIED user id, before any database read, so a
      // client cannot spend a stranger's budget with a forged `sub`.
      if (!this.handshakeLimiter.tryConsume(claims.sub)) {
        throw new WsException('Reconnecting too quickly');
      }
      const user = await this.users.findOne({
        where: { id: claims.sub },
        select: { id: true, role: true, status: true },
      });
      // The row's status, read live, so a ban lands at the next handshake
      // even while the token still carries the old claim.
      if (!user || user.status !== UserStatus.Active) {
        throw new WsException('Unauthorized');
      }
      await this.assertNotLockedOut(user.role);
      await this.assertSessionLive(claims.sid);
      const viewer = await this.resolveStaffViewer(user.id, user.role);
      // The client may have gone while the checks above awaited; a dead
      // socket must not arm a timer nobody will clear.
      if (!client.connected) {
        return null;
      }
      const millisecondsLeft = claims.exp * 1000 - Date.now();
      if (millisecondsLeft <= 0) {
        client.disconnect(true);
        return null;
      }
      client.data.viewer = viewer;
      const expiryTimer = setTimeout(
        () => client.disconnect(true),
        millisecondsLeft,
      );
      expiryTimer.unref?.();
      client.data.expiryTimer = expiryTimer;
      return viewer;
    } catch (error) {
      this.logger.debug(
        `Desk presence handshake refused: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      client.emit('exception', { status: 'error', message: 'Unauthorized' });
      client.disconnect(true);
      return null;
    }
  }

  handleDisconnect(client: DeskSocket): void {
    if (client.data.expiryTimer) {
      clearTimeout(client.data.expiryTimer);
    }
    const viewer = client.data.viewer;
    if (!viewer) {
      return;
    }
    this.presence.releaseSocket(viewer.userId, client.id, (pieceId) => {
      this.broadcastPiece(pieceId);
      this.scheduleDeskBroadcast();
    });
  }

  onModuleDestroy(): void {
    if (this.deskBroadcastTimer) {
      clearTimeout(this.deskBroadcastTimer);
      this.deskBroadcastTimer = null;
    }
    if (this.handshakeBucketSweepTimer) {
      clearInterval(this.handshakeBucketSweepTimer);
      this.handshakeBucketSweepTimer = null;
    }
  }

  /**
   * Lockdown is the platform kill switch: drop every open desk socket, as
   * `ChatGateway.handleLockdownEnabled` does, and let the handshake sort who
   * may come back. Single replica only, like the rest of this gateway.
   */
  @OnEvent(PLATFORM_LOCKDOWN_ENABLED)
  handleLockdownEnabled(payload: PlatformLockdownEnabledEvent): void {
    this.logger.warn(
      `Lockdown enabled by ${payload.actorId}: disconnecting desk presence sockets`,
    );
    this.namespace?.disconnectSockets(true);
  }

  @SubscribeMessage('desk:watch')
  async handleDeskWatch(@ConnectedSocket() client: DeskSocket): Promise<void> {
    await this.requireViewer(client);
    await client.join(DESK_ROOM);
    // Prime this socket at once; the throttled broadcast is for changes.
    client.emit('desk:viewers', { byPiece: this.presence.viewersByPiece() });
  }

  @SubscribeMessage('piece:watch')
  async handlePieceWatch(
    @ConnectedSocket() client: DeskSocket,
    @MessageBody() payload: PieceWatchPayload,
  ): Promise<void> {
    const viewer = await this.requireViewer(client);
    // A socket that dropped during the await above has already been
    // released; recording it now would list the editor forever.
    if (!client.connected) {
      return;
    }
    const isAlreadyWatching = this.presence.isWatching(
      client.id,
      payload.pieceId,
    );
    // Checked and recorded in one synchronous segment, so a burst of frames
    // cannot all pass the cap before any of them is counted. Re-watching a
    // piece this socket already holds costs nothing and is always allowed.
    if (
      !isAlreadyWatching &&
      this.presence.watchedPieceCount(client.id) >=
        MAX_WATCHED_PIECES_PER_SOCKET
    ) {
      throw new WsException('Too many pieces watched');
    }
    const hasChanged = this.presence.watch(payload.pieceId, viewer, client.id);
    await client.join(pieceRoom(payload.pieceId));
    if (hasChanged) {
      this.broadcastPiece(payload.pieceId);
      this.scheduleDeskBroadcast();
      return;
    }
    // Nothing changed for the room; answer the joining socket alone.
    client.emit('piece:viewers', {
      pieceId: payload.pieceId,
      viewers: this.presence.viewersOf(payload.pieceId),
    });
  }

  @SubscribeMessage('piece:unwatch')
  async handlePieceUnwatch(
    @ConnectedSocket() client: DeskSocket,
    @MessageBody() payload: PieceWatchPayload,
  ): Promise<void> {
    const viewer = await this.requireViewer(client);
    await client.leave(pieceRoom(payload.pieceId));
    if (this.presence.unwatch(payload.pieceId, viewer.userId, client.id)) {
      this.broadcastPiece(payload.pieceId);
      this.scheduleDeskBroadcast();
    }
  }

  private broadcastPiece(pieceId: string): void {
    this.namespace.to(pieceRoom(pieceId)).emit('piece:viewers', {
      pieceId,
      viewers: this.presence.viewersOf(pieceId),
    });
  }

  /** Trailing throttle: a burst of joins becomes one desk-wide frame. */
  private scheduleDeskBroadcast(): void {
    if (this.deskBroadcastTimer) {
      return;
    }
    this.deskBroadcastTimer = setTimeout(() => {
      this.deskBroadcastTimer = null;
      this.namespace
        .to(DESK_ROOM)
        .emit('desk:viewers', { byPiece: this.presence.viewersByPiece() });
    }, DESK_VIEWERS_THROTTLE_MS);
    this.deskBroadcastTimer.unref?.();
  }

  private async requireViewer(client: DeskSocket): Promise<DeskViewer> {
    const viewer = client.data.viewer ?? (await client.data.admission);
    if (!viewer) {
      throw new WsException('Unauthorized');
    }
    return viewer;
  }

  /** Signature, pinned algorithm and the claims-level status only. */
  private async verifyHandshakeToken(
    client: DeskSocket,
  ): Promise<AccessTokenClaims> {
    const fromAuth = client.handshake.auth?.token as string | undefined;
    const fromCookie = parseCookie(client.handshake.headers.cookie ?? '')[
      'access_token'
    ];
    const rawToken = fromAuth ?? fromCookie;
    if (!rawToken) {
      throw new WsException('Unauthorized');
    }
    const secret = this.config.getOrThrow<string>('auth.jwtAccessSecret');
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(rawToken, {
        secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new WsException('Unauthorized');
    }
    if (claims.status !== UserStatus.Active) {
      throw new WsException('Unauthorized');
    }
    return claims;
  }

  /**
   * The predicate `ChatGateway.assertNotLockedOut` and `PlatformLockdownGuard`
   * share: during a lockdown admins pass, moderators pass only when the
   * lockdown allows them, and everyone else is refused. Settings come from an
   * in-process cache, so an unlocked platform pays nothing here.
   */
  private async assertNotLockedOut(role: UserRole): Promise<void> {
    const settings = await this.platformSettings.get();
    if (!settings.lockdownEnabled) {
      return;
    }
    if (role === UserRole.Admin) {
      return;
    }
    if (role === UserRole.Moderator && settings.lockdownAllowsModerators) {
      return;
    }
    throw new WsException('Platform locked');
  }

  /**
   * Same rule as `ChatGateway.assertSessionLive`: an absent `sid` is a
   * pre-claim token and is admitted; a signed-out device is refused.
   */
  private async assertSessionLive(sessionId: unknown): Promise<void> {
    if (sessionId === undefined || sessionId === '') {
      return;
    }
    if (typeof sessionId !== 'string') {
      throw new WsException('Unauthorized');
    }
    const isSessionLive = await this.refreshTokens.exists({
      where: {
        familyId: sessionId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (!isSessionLive) {
      throw new WsException('Unauthorized');
    }
  }

  /** Admin, or a `magazine_editor` grant, the rule `StaffRolesGuard` applies. */
  private async resolveStaffViewer(
    userId: string,
    role: UserRole,
  ): Promise<DeskViewer> {
    if (role !== UserRole.Admin) {
      const isMagazineEditor = await this.staffRoles.exists({
        where: { userId, role: 'magazine_editor' },
      });
      if (!isMagazineEditor) {
        throw new WsException('Forbidden');
      }
    }
    const profile = await this.profiles.findOne({ where: { userId } });
    const editor = toMagazineEditor(userId, profile);
    if (!editor) {
      throw new WsException('Staff member has no profile');
    }
    return { userId, name: editor.name, initials: editor.initials };
  }
}

function pieceRoom(pieceId: string): string {
  return `piece:${pieceId}`;
}
