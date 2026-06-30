import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
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
import {
  JoinPayload,
  ReadPayload,
  SendMessagePayload,
  TypingPayload,
} from './dto/chat-payloads';
import { PresenceService } from './presence.service';

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
  },
  transports: ['websocket'],
})
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

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly presence: PresenceService,
    private readonly messaging: MessagingService,
    private readonly connections: ConnectionsService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const userId = await this.authenticate(client);
      client.data.userId = userId;
      await client.join(`user:${userId}`);
      if (this.presence.add(userId, client.id)) {
        await this.broadcastPresence(userId, true);
      }
    } catch (err) {
      this.logger.debug(
        `WS handshake auth rejected: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      client.emit('exception', { status: 'error', message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      return;
    }
    if (this.presence.remove(userId, client.id)) {
      await this.broadcastPresence(userId, false);
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
    // Single write path: persists + emits MESSAGE_CREATED → broadcast below.
    await this.messaging.sendMessage(data.conversationId, userId, data.body);
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TypingPayload,
  ): void {
    const userId = this.requireUserId(client);
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

  @OnEvent(MESSAGE_CREATED)
  handleMessageCreated(payload: MessageCreatedEvent): void {
    this.namespace?.to(payload.conversationId).emit('message:new', payload);
  }

  @OnEvent(MESSAGE_READ)
  handleMessageRead(payload: MessageReadEvent): void {
    this.namespace?.to(payload.conversationId).emit('read', payload);
  }

  // --- internals ---

  private requireUserId(client: Socket): string {
    const userId = client.data?.userId as string | undefined;
    if (!userId) {
      throw new WsException('Unauthorized');
    }
    return userId;
  }

  private async authenticate(client: Socket): Promise<string> {
    const fromAuth = client.handshake.auth?.token as string | undefined;
    const fromCookie = parseCookie(client.handshake.headers.cookie ?? '')[
      'access_token'
    ];
    const raw = fromAuth ?? fromCookie;
    if (!raw) {
      throw new WsException('Missing access token');
    }
    const payload = await this.jwt.verifyAsync<{ sub: string }>(raw, {
      secret: this.config.getOrThrow<string>('auth.jwtAccessSecret'),
    });
    return payload.sub;
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
