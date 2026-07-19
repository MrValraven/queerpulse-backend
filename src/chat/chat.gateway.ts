import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
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
import { parseCookie } from 'cookie';
import { Namespace, Socket } from 'socket.io';
import { DEFAULT_LOCKDOWN_MESSAGE } from '../common/lockdown.constants';
import { resolveFrontendOrigins } from '../config/frontend-origins';
import { ConnectionsService } from '../connections/connections.service';
import {
  MESSAGE_CREATED,
  MESSAGE_READ,
  MessageCreatedEvent,
  MessageReadEvent,
} from '../messaging/messaging.events';
import { MessagingService } from '../messaging/messaging.service';
import {
  NOTIFICATION_CREATED,
  NotificationCreatedEvent,
} from '../notifications/notification.events';
import {
  PLATFORM_LOCKDOWN_ENABLED,
  PlatformLockdownEnabledEvent,
} from '../platform-settings/platform-settings.events';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  JoinPayload,
  ReadPayload,
  SendMessagePayload,
  TypingPayload,
} from './dto/chat-payloads';
import { PresenceService } from './presence.service';
import { USER_SESSION_REVOKED, UserSessionRevokedEvent } from './session.events';
import { TokenBucketLimiter } from './ws-rate-limiter';
import { WsAllExceptionsFilter } from './ws-exception.filter';

/**
 * Handshake refusal that the client can TELL APART from an auth failure.
 *
 * Every other handshake rejection is flattened to a generic `Unauthorized` on
 * purpose — an unauthenticated caller learns nothing about why. A lockdown is
 * the exception: it is not the client's credentials that are wrong, and a
 * client that cannot distinguish the two will treat the refusal as an expired
 * token, refresh, and reconnect — in a loop, for the whole lockdown, each
 * attempt costing a JWT verify, a settings read and a user lookup at exactly
 * the moment you want less load. Carrying `PLATFORM_LOCKED` (and the admin's
 * message, which the member is meant to see) lets it back off instead.
 */
export class PlatformLockedWsException extends WsException {
  constructor(lockdownMessage: string) {
    super({
      status: 'error',
      code: 'PLATFORM_LOCKED',
      message: lockdownMessage,
    });
  }
}

/** Verified access-token claims we depend on for the WS handshake. */
interface AccessTokenClaims {
  sub: string;
  status: string;
  /** Standard JWT expiry, seconds since epoch. */
  exp: number;
}

/**
 * Enforce the frontend allowlist on the handshake itself.
 *
 * The `cors` block below does NOT protect this gateway: CORS is not applied to
 * raw WebSocket upgrades, and with polling disabled engine.io never runs the
 * cors layer at all, so that `origin` callback is effectively decorative. Until
 * this existed, the only thing preventing cross-site WebSocket hijacking was
 * `SameSite=Lax` on `access_token` keeping the browser from attaching the cookie
 * cross-site — real protection, but incidental, and it would have evaporated the
 * day someone set `sameSite: 'none'`. `allowRequest` runs on every handshake,
 * upgrade included.
 *
 * A missing `Origin` is allowed: non-browser clients (native apps, tests) do not
 * send one, and they are not the CSWSH threat model — that attack is a browser
 * on an attacker's page, which always sends its origin.
 */
function allowHandshakeOrigin(
  req: { headers: Record<string, string | string[] | undefined> },
  cb: (err: string | null, allow: boolean) => void,
): void {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) {
    cb(null, true);
    return;
  }
  cb(null, resolveFrontendOrigins().includes(origin));
}

@WebSocketGateway({
  namespace: '/chat',
  allowRequest: allowHandshakeOrigin,
  cors: {
    // Resolve the allowlist at connection time rather than at
    // decorator-evaluation time — `process.env.FRONTEND_URL` is only guaranteed
    // to be populated once ConfigModule has loaded `.env`, which happens AFTER
    // this module is imported. Reading it inside the callback defers to
    // handshake time. Handing back the array (not a single string) makes the
    // underlying `cors` layer do a real allowlist match and reflect only the
    // matching origin. Shared with main.ts's HTTP CORS via
    // `resolveFrontendOrigins` so the two can't drift.
    //
    // Retained for the polling transport and for correct preflight replies if
    // `transports` is ever widened; `allowRequest` above is what actually
    // enforces the allowlist today.
    origin: (
      _origin: string | undefined,
      cb: (err: Error | null, allow?: boolean | string | string[]) => void,
    ) => cb(null, resolveFrontendOrigins()),
    credentials: true,
  },
  transports: ['websocket'],
})
@UseFilters(new WsAllExceptionsFilter())
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    exceptionFactory: (errors) => new WsException(errors),
  }),
)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() namespace: Namespace;
  private readonly logger = new Logger(ChatGateway.name);

  // WS abuse limits — the global HTTP ThrottlerGuard skips WS contexts, so the
  // gateway owns its own per-user token buckets (keyed on client.data.userId).
  private readonly messageLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 5,
  });
  private readonly typingLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 10,
  });

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly presence: PresenceService,
    private readonly messaging: MessagingService,
    private readonly connections: ConnectionsService,
    private readonly users: UsersService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const { userId, exp } = await this.authenticate(client);
      client.data.userId = userId;
      client.data.exp = exp;
      await client.join(`user:${userId}`);
      // A socket must not outlive its 15-min access token; drop it at expiry so
      // the client reconnects with a freshly-refreshed cookie.
      this.scheduleTokenExpiry(client, exp);
      if (this.presence.add(userId, client.id)) {
        await this.broadcastPresence(userId, true);
      }
      // Prime the client with who among its connections is already online.
      await this.emitPresenceSnapshot(client, userId);
    } catch (err) {
      this.logger.debug(
        `WS handshake auth rejected: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      // A lockdown says so explicitly; everything else stays a generic
      // `Unauthorized` — do not widen what other failures disclose.
      client.emit(
        'exception',
        err instanceof PlatformLockedWsException
          ? err.getError()
          : { status: 'error', message: 'Unauthorized' },
      );
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const timer = client.data?.expiryTimer as NodeJS.Timeout | undefined;
    if (timer) {
      clearTimeout(timer);
    }
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return;
    }
    if (this.presence.remove(userId, client.id)) {
      await this.broadcastPresence(userId, false);
      // Last socket gone — free the per-user rate-limit buckets.
      this.messageLimiter.clear(userId);
      this.typingLimiter.clear(userId);
    }
  }

  @SubscribeMessage('conversation:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinPayload,
  ): Promise<{ joined: string }> {
    const userId = this.requireUserId(client);
    if (!(await this.messaging.isParticipant(data.conversationId, userId))) {
      throw new WsException('Not a participant');
    }
    await client.join(data.conversationId);
    return { joined: data.conversationId };
  }

  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SendMessagePayload,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    if (!this.messageLimiter.tryConsume(userId)) {
      throw new WsException('You are sending messages too quickly');
    }
    // Single write path: persists + emits MESSAGE_CREATED → broadcast below.
    await this.messaging.sendMessage(data.conversationId, userId, data.body);
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TypingPayload,
  ): void {
    const userId = this.requireUserId(client);
    // Only members who have joined the conversation room may broadcast typing.
    if (!client.rooms.has(data.conversationId)) {
      throw new WsException('Join the conversation before typing');
    }
    if (!this.typingLimiter.tryConsume(userId)) {
      // Silently drop — typing is advisory; no need to error the client.
      return;
    }
    client.to(data.conversationId).emit('typing', {
      conversationId: data.conversationId,
      userId,
      isTyping: data.isTyping,
    });
  }

  @SubscribeMessage('read')
  async handleRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ReadPayload,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    await this.messaging.markRead(data.conversationId, userId);
  }

  @SubscribeMessage('presence:snapshot')
  async handlePresenceSnapshot(
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    await this.emitPresenceSnapshot(client, userId);
  }

  @OnEvent(MESSAGE_CREATED)
  handleMessageCreated(payload: MessageCreatedEvent): void {
    this.namespace?.to(payload.conversationId).emit('message:new', payload);
  }

  @OnEvent(MESSAGE_READ)
  handleMessageRead(payload: MessageReadEvent): void {
    this.namespace?.to(payload.conversationId).emit('read', payload);
  }

  /**
   * Push a newly-created notification to its recipient's live sockets.
   *
   * Fans out to the `user:${userId}` room (joined at handshake, so this reaches
   * every tab that member has open) rather than a conversation room — a
   * notification is addressed to one person, not to a thread.
   *
   * The socket event is `notification:new`; the internal event-emitter topic it
   * listens to is `notification.created`. Different namespaces, same as
   * MESSAGE_CREATED → `message:new` above.
   */
  @OnEvent(NOTIFICATION_CREATED)
  handleNotificationCreated(payload: NotificationCreatedEvent): void {
    this.namespace
      ?.to(`user:${payload.userId}`)
      .emit('notification:new', payload.notification);
  }

  /**
   * Force-drop every live socket for a member (logout / suspension / token
   * reuse). Auth emits {@link USER_SESSION_REVOKED}; we disconnect the whole
   * `user:${userId}` room.
   *
   * SINGLE-REPLICA ONLY. This reaches sockets held by THIS instance. There is no
   * Redis adapter configured (see ThrottlerModule's note in app.module.ts), so
   * with 2+ replicas a revoked member keeps a live socket on every instance that
   * did not handle the logout. Adding replicas requires @socket.io/redis-adapter
   * wired via `app.useWebSocketAdapter` before this is safe.
   */
  @OnEvent(USER_SESSION_REVOKED)
  handleSessionRevoked(payload: UserSessionRevokedEvent): void {
    this.namespace?.in(`user:${payload.userId}`).disconnectSockets(true);
  }

  /**
   * Drop every live socket the moment an admin turns the lockdown on.
   *
   * `assertNotLockedOut` only runs at the handshake, so without this a socket
   * opened before the flip keeps sending and receiving for the remaining life
   * of its 15-minute access token: HTTP would go dark within one request while
   * chat stayed live for a quarter of an hour.
   *
   * A BLANKET disconnect, not a filtered one. Staff reconnect immediately and
   * pass the handshake check on their way back in, so filtering by role here
   * would buy nothing and would cost a database lookup per connected socket at
   * the worst possible moment.
   *
   * SINGLE-REPLICA ONLY, for the same reason as `handleSessionRevoked` above:
   * this reaches sockets held by THIS instance, and there is no Redis adapter
   * configured (see ThrottlerModule's note in app.module.ts). With 2+ replicas,
   * sockets on instances that did not handle the PATCH survive until their
   * token expires. Adding replicas requires @socket.io/redis-adapter wired via
   * `app.useWebSocketAdapter` before this is safe.
   */
  @OnEvent(PLATFORM_LOCKDOWN_ENABLED)
  handleLockdownEnabled(payload: PlatformLockdownEnabledEvent): void {
    this.logger.warn(
      `Lockdown enabled by ${payload.actorId} — disconnecting all live sockets`,
    );
    this.namespace?.disconnectSockets(true);
  }

  // --- internals ---

  private requireUserId(client: Socket): string {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      throw new WsException('Unauthorized');
    }
    return userId;
  }

  private async authenticate(
    client: Socket,
  ): Promise<{ userId: string; exp: number }> {
    const fromAuth = client.handshake.auth?.token as string | undefined;
    const fromCookie = parseCookie(client.handshake.headers.cookie ?? '')[
      'access_token'
    ];
    const raw = fromAuth ?? fromCookie;
    if (!raw) {
      throw new WsException('Missing access token');
    }
    // verifyAsync rejects an expired or tampered token (throws → handshake fail).
    const payload = await this.jwt.verifyAsync<AccessTokenClaims>(raw, {
      secret: this.config.getOrThrow<string>('auth.jwtAccessSecret'),
    });
    // Enforce active membership on the WS path (parity with ActiveMemberGuard).
    if (payload.status !== UserStatus.Active) {
      throw new WsException('Active membership required');
    }
    // Platform lockdown, repeated here because PlatformLockdownGuard governs
    // HTTP only — without this, websockets stay wide open during a lockdown.
    // The role has to come from the database: the access token carries `sub`,
    // `status` and `exp`, but no role claim.
    await this.assertNotLockedOut(payload.sub);
    return { userId: payload.sub, exp: payload.exp };
  }

  /**
   * Throws unless the platform is unlocked, or this user is staff allowed
   * through it.
   *
   * SHARED with `PlatformLockdownGuard`: the predicate (admins always pass;
   * moderators pass only when `lockdownAllowsModerators`; everyone else is
   * refused), the default copy (`DEFAULT_LOCKDOWN_MESSAGE`), and the
   * `PLATFORM_LOCKED` code. Change the rule in one and you must change the
   * other.
   *
   * NOT shared, and deliberately so:
   * - **Scope.** The guard reads `req.user.role`, already populated by
   *   `JwtStrategy`. There is no request here, so the role has to be fetched
   *   from the database — the access token carries `sub`, `status` and `exp`,
   *   but no role claim. A deleted user therefore fails closed here.
   * - **Timing.** The guard runs per request, so HTTP goes dark immediately.
   *   This runs once, at the handshake. Sockets already open when lockdown is
   *   enabled are dropped by the {@link PLATFORM_LOCKDOWN_ENABLED} listener
   *   instead, not by this method.
   * - **Error shape.** The guard throws an HTTP 503; this throws a
   *   {@link PlatformLockedWsException}, which `handleConnection` emits to the
   *   client as a socket `exception` frame. There is no status code on a
   *   WebSocket to carry the 503.
   * - **Exemptions.** `@LockdownExempt()` has no meaning here; there is no
   *   handler metadata on a handshake.
   */
  private async assertNotLockedOut(userId: string): Promise<void> {
    const settings = await this.platformSettings.get();
    if (!settings.lockdownEnabled) {
      return;
    }
    const user = await this.users.findById(userId);
    const role = user?.role;
    if (role === UserRole.Admin) {
      return;
    }
    if (role === UserRole.Moderator && settings.lockdownAllowsModerators) {
      return;
    }
    // `||`, not `??`: an admin who clears the message textarea sends `''`.
    throw new PlatformLockedWsException(
      settings.lockdownMessage || DEFAULT_LOCKDOWN_MESSAGE,
    );
  }

  private scheduleTokenExpiry(client: Socket, exp: number): void {
    const msUntilExpiry = exp * 1000 - Date.now();
    if (msUntilExpiry <= 0) {
      client.emit('exception', { status: 'error', message: 'Token expired' });
      client.disconnect(true);
      return;
    }
    const timer = setTimeout(() => {
      client.emit('exception', { status: 'error', message: 'Token expired' });
      client.disconnect(true);
    }, msUntilExpiry);
    // Don't let a pending expiry timer keep the event loop alive on shutdown.
    timer.unref?.();
    client.data.expiryTimer = timer;
  }

  private async emitPresenceSnapshot(
    client: Socket,
    userId: string,
  ): Promise<void> {
    const connectionIds =
      await this.connections.getAcceptedConnectionUserIds(userId);
    const online = connectionIds.filter((id) => this.presence.isOnline(id));
    client.emit('presence:snapshot', { online });
  }

  private async broadcastPresence(
    userId: string,
    online: boolean,
  ): Promise<void> {
    const connectionIds =
      await this.connections.getAcceptedConnectionUserIds(userId);
    for (const otherId of connectionIds) {
      this.namespace?.to(`user:${otherId}`).emit('presence', {
        userId,
        online,
      });
    }
  }
}
