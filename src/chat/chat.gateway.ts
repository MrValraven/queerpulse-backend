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
import { ConnectionsService } from '../connections/connections.service';
import {
  MESSAGE_CREATED,
  MESSAGE_READ,
  MessageCreatedEvent,
  MessageReadEvent,
} from '../messaging/messaging.events';
import { MessagingService } from '../messaging/messaging.service';
import { UserStatus } from '../users/entities/user.entity';
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

/** Verified access-token claims we depend on for the WS handshake. */
interface AccessTokenClaims {
  sub: string;
  status: string;
  /** Standard JWT expiry, seconds since epoch. */
  exp: number;
}

/**
 * Resolve the allowed CORS origin at connection time rather than at
 * decorator-evaluation time — `process.env.FRONTEND_URL` is only guaranteed to
 * be populated once ConfigModule has loaded `.env`, which happens AFTER this
 * module is imported. Reading it inside the callback defers to handshake time.
 */
function resolveCorsOrigin(): string {
  return process.env.FRONTEND_URL ?? 'http://localhost:5173';
}

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: (
      _origin: string | undefined,
      cb: (err: Error | null, allow?: boolean | string | string[]) => void,
    ) => cb(null, resolveCorsOrigin()),
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
      client.emit('exception', { status: 'error', message: 'Unauthorized' });
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
   * Force-drop every live socket for a member (logout / suspension / token
   * reuse). Auth emits {@link USER_SESSION_REVOKED}; we disconnect the whole
   * `user:${userId}` room, which fans out across instances under the Redis
   * adapter.
   */
  @OnEvent(USER_SESSION_REVOKED)
  handleSessionRevoked(payload: UserSessionRevokedEvent): void {
    this.namespace?.in(`user:${payload.userId}`).disconnectSockets(true);
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
    return { userId: payload.sub, exp: payload.exp };
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
