import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
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
import { parseCookie } from 'cookie';
import { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { DEFAULT_LOCKDOWN_MESSAGE } from '../common/lockdown.constants';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { resolveFrontendOrigins } from '../config/frontend-origins';
import { ConnectionsService } from '../connections/connections.service';
import {
  CONVERSATION_CREATED,
  CONVERSATION_MEMBERSHIP_REVOKED,
  ConversationCreatedEvent,
  ConversationMembershipRevokedEvent,
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_DELIVERED,
  MESSAGE_PINNED,
  MESSAGE_READ,
  MESSAGE_REACTION,
  MESSAGE_UPDATED,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageDeliveredEvent,
  MessagePinnedEvent,
  MessageReadEvent,
  MessageReactionEvent,
  MessageUpdatedEvent,
} from '../messaging/messaging.events';
import { MessagingService } from '../messaging/messaging.service';
import { MEMBER_BLOCKED, MemberBlockedEvent } from '../social/social.events';
import {
  NOTIFICATION_CREATED,
  NotificationCreatedEvent,
} from '../notifications/notification.events';
import { toNotificationResponse } from '../notifications/notification-response';
import {
  PLATFORM_LOCKDOWN_ENABLED,
  PlatformLockdownEnabledEvent,
} from '../platform-settings/platform-settings.events';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  DeliveredPayload,
  JoinPayload,
  ReadPayload,
  SendMessagePayload,
  TypingPayload,
} from './dto/chat-payloads';
import { PresenceService } from './presence.service';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from './session.events';
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
  status: UserStatus;
  /** Standard JWT expiry, seconds since epoch. */
  exp: number;
  /**
   * The SESSION this token was minted for: the `refresh_tokens.family_id` of
   * the sign-in it descends from, assigned once and carried through every
   * rotation. `AuthService` signs it into every access token it mints, and
   * `JwtStrategy` reads the same claim on the HTTP path. See
   * `assertSessionLive` for why it is OPTIONAL and must stay that way.
   */
  sid?: string;
}

/**
 * Per-connection state we stash on `Socket.data` during the handshake. Typing
 * it (rather than leaving socket.io's default `any`) keeps every `client.data`
 * read/write checked instead of unsafe.
 */
interface ChatSocketData {
  userId?: string;
  exp?: number;
  expiryTimer?: NodeJS.Timeout;
}

type ChatSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  ChatSocketData
>;

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
// ONE validation contract, shared by both transports.
//
// `message:send` and `POST /conversations/:id/messages` land in the identical
// `MessagingService.sendMessage`, so they must be validated identically. This
// pipe used to list `whitelist` and `transform` by hand and omitted
// `forbidNonWhitelisted`, which meant an unknown body key was a 400 over HTTP
// and a silent strip over the socket: the same write accepted under weaker
// rules on the transport a client is most likely to get wrong (a hand-rolled
// `socket.emit` has no OpenAPI-ish contract to check itself against, so a typo
// like `replyTo` instead of `replyToId` was dropped on the floor and the
// message was persisted without its reply reference). Spreading
// `VALIDATION_PIPE_OPTIONS` (the same object `main.ts` binds globally) makes
// the two impossible to drift apart again.
//
// `transformOptions: { exposeUnsetFields: false }` comes along with the spread
// and is safe here: every `@SubscribeMessage` handler below reads named fields
// off the payload (`data.conversationId`, `data.replyToId`, ...) and passes
// them on as positional arguments or as a freshly-built literal. Nothing in
// this gateway spreads a WS payload over an entity, `Object.assign`s one, or
// asks whether a key was ABSENT versus present-and-undefined, which is the one
// case that option changes (see its doc comment in
// `common/validation-pipe.options.ts`).
//
// The `exceptionFactory` stays gateway-specific: HTTP wants the default
// `BadRequestException`, while a WS handler must throw `WsException` so
// `WsAllExceptionsFilter` can deliver it down the socket as an `exception`
// frame instead of crashing the handler. It is listed AFTER the spread so it
// keeps winning if the shared options ever grow one of their own.
@UsePipes(
  new ValidationPipe({
    ...VALIDATION_PIPE_OPTIONS,
    exceptionFactory: (errors) => new WsException(errors),
  }),
)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() namespace!: Namespace;
  private readonly logger = new Logger(ChatGateway.name);

  // WS abuse limits — the global HTTP ThrottlerGuard skips WS contexts, so the
  // gateway owns its own per-user token buckets (keyed on client.data.userId).
  //
  // The send bucket is deliberately ALIGNED with the HTTP ceiling on the same
  // write: `POST /conversations/:id/messages` is throttled at 60 per 60s, and
  // both transports land in the identical `MessagesService.sendMessage` (which
  // fans out to push and to the whole room). At `refillPerSecond: 5` the socket
  // sustained 300 messages a minute — five times the number the HTTP limit was
  // tuned for — so a spammer simply used the socket. `capacity: 10` keeps the
  // burst headroom a real typing session needs; `refillPerSecond: 1` puts the
  // sustained rate at the same 60/min.
  private readonly messageLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 1,
  });
  private readonly typingLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 10,
  });
  // Delivered acks are already client-throttled (one "received up to now" stamp
  // per burst per conversation), but bound them here too — a misbehaving client
  // must not turn the receipt into a write amplifier.
  private readonly deliveredLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 5,
  });

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly presence: PresenceService,
    private readonly messaging: MessagingService,
    private readonly connections: ConnectionsService,
    private readonly users: UsersService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly metrics: MetricsService,
    // Read-side only, and for a single `exists` on one indexed column: the
    // handshake asks whether the session behind the presented access token is
    // still live (`assertSessionLive`). `AuthService` owns every write to this
    // table. Injecting the repository rather than `AuthService` keeps the edge
    // out of `ChatModule` a TypeORM feature registration instead of a module
    // import. `AuthModule` pulls membership, vouch, connections and
    // media-crops in behind it, all for one `exists` query.
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  async handleConnection(client: ChatSocket): Promise<void> {
    try {
      const { userId, exp } = await this.authenticate(client);
      client.data.userId = userId;
      client.data.exp = exp;
      // Count the live socket now that it is authenticated. Set BEFORE any step
      // that can throw: a later failure disconnects the socket, and
      // handleDisconnect (which sees `userId` set) decrements to rebalance.
      this.metrics.incrementWebsocketConnections();
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

  async handleDisconnect(client: ChatSocket): Promise<void> {
    const timer = client.data.expiryTimer;
    if (timer) {
      clearTimeout(timer);
    }
    const userId = client.data.userId;
    if (!userId) {
      return;
    }
    // Balances the increment in handleConnection (only reached once `userId` is
    // set, i.e. only for sockets that were counted).
    this.metrics.decrementWebsocketConnections();
    if (this.presence.remove(userId, client.id)) {
      await this.broadcastPresence(userId, false);
      // Last socket gone — free the per-user rate-limit buckets.
      this.messageLimiter.clear(userId);
      this.typingLimiter.clear(userId);
      this.deliveredLimiter.clear(userId);
    }
  }

  @SubscribeMessage('conversation:join')
  async handleJoin(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: JoinPayload,
  ): Promise<{ joined: string }> {
    const userId = this.requireUserId(client);
    // Stricter than plain participation (P0 hardening): also refuses a
    // participant who left/was removed from a group (no live room for them —
    // history stays reachable over HTTP) and a DM whose counterpart is
    // blocked either way (so a block also cuts off live message/typing
    // reception, not just new sends). See `canJoinConversationLive`'s doc.
    if (
      !(await this.messaging.canJoinConversationLive(
        data.conversationId,
        userId,
      ))
    ) {
      throw new WsException('Not a participant');
    }
    await client.join(data.conversationId);
    return { joined: data.conversationId };
  }

  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: SendMessagePayload,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    if (!this.messageLimiter.tryConsume(userId)) {
      throw new WsException('You are sending messages too quickly');
    }
    // Single write path: persists + emits MESSAGE_CREATED → broadcast below.
    // `clientMessageId` makes this idempotent against the HTTP POST path.
    await this.messaging.sendMessage(
      data.conversationId,
      userId,
      data.body,
      data.replyToId,
      data.clientMessageId,
      undefined, // forwarded — the WS path never forwards
      data.kind,
      data.attachment,
    );
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: TypingPayload,
  ): void {
    const userId = this.requireUserId(client);
    // Only members who have joined the conversation room may broadcast typing.
    // Silently drop rather than throw when the room isn't joined yet: `typing`
    // is advisory (see the rate-limit branch below), and `conversation:join` is
    // an async handler racing this fire-and-forget frame — a client that opens a
    // thread and types immediately (or reconnects) legitimately lands here for a
    // sub-millisecond window before `client.join` completes. Erroring turned that
    // benign race into a full stack trace + Sentry event on every occurrence
    // (WsException is not an HttpException, so the filter logs it as a server
    // fault). The security invariant still holds — a socket not in the room does
    // not broadcast into it — and the composer re-emits `typing:true` every ~2s,
    // so the indicator still appears once the join lands.
    if (!client.rooms.has(data.conversationId)) {
      return;
    }
    if (!this.typingLimiter.tryConsume(userId)) {
      // Silently drop — typing is advisory; no need to error the client.
      return;
    }
    // `client.to(room)` excludes only the SENDING SOCKET, not the sending user.
    // A member signed in on two devices (phone + laptop) has two sockets in this
    // room, so without `.except` their own "typing" frame echoes to their other
    // device and renders as "the other person is typing". Exclude the sender's
    // whole `user:<id>` room so none of their own devices ever see it — typing is
    // only ever meaningful about OTHER participants.
    client.to(data.conversationId).except(`user:${userId}`).emit('typing', {
      conversationId: data.conversationId,
      userId,
      isTyping: data.isTyping,
    });
  }

  @SubscribeMessage('read')
  async handleRead(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: ReadPayload,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    await this.messaging.markRead(data.conversationId, userId, {
      upToMessageId: data.upToMessageId,
    });
  }

  @SubscribeMessage('delivered')
  async handleDelivered(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: DeliveredPayload,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    // Advisory like typing: over the limit we silently drop rather than error —
    // the watermark is monotonic, so a skipped ack is corrected by the next one.
    if (!this.deliveredLimiter.tryConsume(userId)) {
      return;
    }
    // Persist the delivered watermark + emit MESSAGE_DELIVERED (relayed below).
    // `markDelivered` re-checks participation, so an un-joined caller is refused.
    await this.messaging.markDelivered(data.conversationId, userId);
  }

  @SubscribeMessage('presence:snapshot')
  async handlePresenceSnapshot(
    @ConnectedSocket() client: ChatSocket,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    await this.emitPresenceSnapshot(client, userId);
  }

  @OnEvent(MESSAGE_CREATED)
  handleMessageCreated(payload: MessageCreatedEvent): void {
    // Broadcast the frontend-contract `response` (not the internal `MessageView`)
    // so live clients patch it straight into the thread cache and reconcile the
    // sender's optimistic bubble by `clientMessageId` — no refetch.
    this.namespace?.to(payload.conversationId).emit('message:new', {
      conversationId: payload.conversationId,
      message: payload.response,
    });
  }

  @OnEvent(MESSAGE_UPDATED)
  handleMessageUpdated(payload: MessageUpdatedEvent): void {
    this.namespace?.to(payload.conversationId).emit('message:updated', payload);
  }

  /**
   * A new conversation (a group) was created: notify EACH member's
   * `user:<id>` room so their inbox refetches live. The members weren't in the
   * conversation room yet (they join it when they open the thread), so a
   * room-scoped `message:new` would miss them — this is the user-room fan-out
   * that gets the new group in front of them. Carries only the id; the client
   * invalidates `["conversations"]` and re-fetches the DTO.
   */
  @OnEvent(CONVERSATION_CREATED)
  handleConversationCreated(payload: ConversationCreatedEvent): void {
    for (const memberUserId of payload.memberUserIds) {
      this.namespace
        ?.to(`user:${memberUserId}`)
        .emit('conversation:new', { conversationId: payload.conversationId });
    }
  }

  @OnEvent(MESSAGE_READ)
  handleMessageRead(payload: MessageReadEvent): void {
    this.namespace?.to(payload.conversationId).emit('read', payload);
  }

  @OnEvent(MESSAGE_DELIVERED)
  handleMessageDelivered(payload: MessageDeliveredEvent): void {
    // Relayed to the whole conversation room; the SENDER's client uses the
    // `userId` (the recipient who acked) + `deliveredAt` to advance its
    // one-check → two-check tick. `deliveredAt` is a Date here; socket.io
    // serialises it to an ISO string on the wire (as with `read`'s lastReadAt).
    this.namespace
      ?.to(payload.conversationId)
      .emit('message:delivered', payload);
  }

  @OnEvent(MESSAGE_REACTION)
  handleMessageReaction(payload: MessageReactionEvent): void {
    this.namespace?.to(payload.conversationId).emit('reaction', payload);
  }

  @OnEvent(MESSAGE_DELETED)
  handleMessageDeleted(payload: MessageDeletedEvent): void {
    this.namespace?.to(payload.conversationId).emit('message:deleted', payload);
  }

  @OnEvent(MESSAGE_PINNED)
  handleMessagePinned(payload: MessagePinnedEvent): void {
    // Pins are shared: relay to the whole conversation room so BOTH participants
    // refresh the pinned-messages banner (and patch the message's pin state) —
    // no blanket thread invalidation.
    this.namespace?.to(payload.conversationId).emit('message:pinned', payload);
  }

  /**
   * Evict a member's sockets from a conversation room they may no longer
   * receive from (removed from a group, left one).
   *
   * Room membership was authorised exactly ONCE, by `handleJoin`; every
   * broadcast after that (`message:new`, `typing`, `read`, `message:delivered`,
   * `reaction`, `message:deleted`, `message:pinned`) is a blind `to(room)`
   * emit. Without this eviction a removed member kept a live subscription to
   * every one of those frames until their socket reconnected — silently undoing
   * both the HTTP read path's `leftAt` ceiling and `canJoinConversationLive`'s
   * refusal to let them back in.
   *
   * `socketsLeave` (not `disconnectSockets`): the member's OTHER conversations,
   * notifications and presence are untouched — only this room is cut.
   *
   * SINGLE-REPLICA ONLY, same caveat as {@link handleSessionRevoked}.
   */
  @OnEvent(CONVERSATION_MEMBERSHIP_REVOKED)
  handleConversationMembershipRevoked(
    payload: ConversationMembershipRevokedEvent,
  ): void {
    for (const userId of payload.userIds) {
      this.namespace?.in(`user:${userId}`).socketsLeave(payload.conversationId);
    }
  }

  /**
   * A block severs the pair's live DM room in BOTH directions.
   *
   * `canJoinConversationLive` already refuses a fresh join from either side
   * once a block exists, and `sendMessage`/`createConversation` refuse the
   * write — but sockets already inside the room were never pushed out, so the
   * blocked member kept receiving the blocker's messages, typing indicators and
   * read receipts. Both entry points that place a block
   * (`SocialService.blockMember`, `ConnectionsService.respond('block')`) emit
   * {@link MEMBER_BLOCKED}, so which button was pressed no longer decides
   * whether the block takes effect live.
   *
   * Async because the DM room ids have to be resolved first; the emitter
   * awaits nothing, so failures are logged here rather than surfacing to the
   * blocker's request (which has already committed).
   */
  @OnEvent(MEMBER_BLOCKED)
  async handleMemberBlocked(payload: MemberBlockedEvent): Promise<void> {
    try {
      const conversationIds = await this.messaging.directConversationIdsBetween(
        payload.blockerId,
        payload.blockedId,
      );
      for (const conversationId of conversationIds) {
        this.namespace
          ?.in(`user:${payload.blockerId}`)
          .socketsLeave(conversationId);
        this.namespace
          ?.in(`user:${payload.blockedId}`)
          .socketsLeave(conversationId);
      }
    } catch (err) {
      this.logger.error(
        `Failed to evict blocked pair from their DM room: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
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
    // Emit the hand-mapped response DTO, never the raw entity — its `payload`
    // is opaque jsonb whose allowlist projection (`toNotificationResponse` →
    // `toClientPayload`) strips content-bearing fields like `excerpt` before
    // they cross the wire (finding M6, backstopping H3). The client refetches
    // the feed on this frame for its full render, so the actor is resolved
    // there; passing `undefined` keeps this handler query-free (it does no DB
    // work), matching the raw-entity relay it replaces (which carried no
    // resolved actor either).
    this.namespace
      ?.to(`user:${payload.userId}`)
      .emit(
        'notification:new',
        toNotificationResponse(payload.notification, undefined),
      );
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

  private requireUserId(client: ChatSocket): string {
    const userId = client.data.userId;
    if (!userId) {
      throw new WsException('Unauthorized');
    }
    return userId;
  }

  private async authenticate(
    client: ChatSocket,
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
      algorithms: ['HS256'],
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
    // Ordered AFTER the lockdown check on purpose: `platformSettings.get()` is
    // served from an in-process cache, so an unlocked platform pays nothing for
    // it, and a LOCKED one refuses here without ever spending the query below,
    // which is exactly when the gateway is being retried by every signed-in
    // member at once. A revoked device refused during a lockdown is told
    // `PLATFORM_LOCKED` rather than `Unauthorized`, which is the friendlier of
    // the two answers and the one that makes the client back off hardest.
    await this.assertSessionLive(payload.sid);
    return { userId: payload.sub, exp: payload.exp };
  }

  /**
   * Throws unless the refresh-token FAMILY this access token was minted for is
   * still alive.
   *
   * "Sign out this device" on the security page revokes a family and emits
   * {@link USER_SESSION_REVOKED}, which {@link handleSessionRevoked} above turns
   * into a one-shot drop of the member's `user:<id>` room. That drop is the
   * whole story only for sockets that are open at that instant. The signed-out
   * device still holds a valid access token for the rest of its 15-minute TTL,
   * so it simply reconnected and was let straight back in, because the
   * handshake asked only whether the token verified. The member was told the
   * device was signed out while it went on receiving direct messages and
   * presence. This is the check that makes the security page's promise true on
   * the socket path, the same way `JwtStrategy.validate` makes it true on the
   * HTTP path.
   *
   * SEMANTICS MIRROR `JwtStrategy.isSessionLive` EXACTLY, and they have to: a
   * device refused on one transport and admitted on the other is the bug this
   * closes, wearing a different hat.
   *
   * - An ABSENT `sid` is ADMITTED. A token with no `sid` can only be one this
   *   server minted before the deploy that added the claim, and the signature
   *   proves it came from us. Such a token expires within one access TTL, so
   *   the gap closes itself. Rejecting it instead would drop every signed-in
   *   member's socket the moment the deploy landed, which is a worse outcome
   *   than a fifteen-minute tail on revocations reaching devices that already
   *   hold a valid token.
   * - A `sid` present but not a string is REFUSED. It would otherwise skip the
   *   lookup silently, and a check that can be switched off by sending the
   *   wrong type is not a check. The claims interface says `string`; a decoded
   *   JWT is runtime data, so the parameter is `unknown` and earns its type
   *   here.
   * - A family that is revoked OR expired is REFUSED. Both conditions are
   *   needed, matching what `AccountService.listSessions` shows the member as a
   *   live session: `revoked_at IS NULL` alone would keep a family that had run
   *   out its 30-day life usable for the further 30 days the purge job waits.
   *
   * CHEAP, which matters because this runs on every connection: one `exists`
   * against `IDX_refresh_tokens_family_id`, so Postgres stops at the first
   * matching row and returns a boolean rather than hydrating an entity. Nothing
   * is cached, and nothing should be: a cache here would reintroduce the very
   * window the check exists to close.
   */
  private async assertSessionLive(sessionId: unknown): Promise<void> {
    if (sessionId === undefined) {
      return;
    }
    if (typeof sessionId !== 'string') {
      throw new WsException('Malformed access token payload');
    }
    // An empty string names no session, and `JwtStrategy.isSessionLive` reads
    // it the same way (its falsy guard covers both). No minted token carries
    // one, since a family id is always a uuid.
    if (sessionId === '') {
      return;
    }
    const isSessionLive = await this.refreshTokens.exists({
      where: {
        familyId: sessionId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (!isSessionLive) {
      throw new WsException('Session has been signed out');
    }
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

  private scheduleTokenExpiry(client: ChatSocket, exp: number): void {
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
    client: ChatSocket,
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
