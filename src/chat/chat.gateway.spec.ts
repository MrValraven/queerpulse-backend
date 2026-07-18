// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Mocking it
// here keeps the real module out of the transform pipeline and lets us drive
// cookie-based handshake auth deterministically.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { parseCookie } from 'cookie';
import { ConnectionsService } from '../connections/connections.service';
import { MessagingService } from '../messaging/messaging.service';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';

const mockedParseCookie = parseCookie as unknown as jest.Mock;

interface FakeClient {
  id: string;
  data: Record<string, unknown>;
  rooms: Set<string>;
  handshake: {
    auth: { token?: string };
    headers: { cookie?: string };
  };
  join: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  to: jest.Mock;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    id: 'sock1',
    data: {},
    rooms: new Set<string>(),
    handshake: { auth: {}, headers: {} },
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    ...overrides,
  };
}

const futureExp = (): number => Math.floor(Date.now() / 1000) + 900;

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let verifyAsync: jest.Mock;
  let messaging: {
    sendMessage: jest.Mock;
    markRead: jest.Mock;
    isParticipant: jest.Mock;
  };
  let connections: { getAcceptedConnectionUserIds: jest.Mock };
  let presence: PresenceService;
  let roomEmit: jest.Mock;
  let disconnectSockets: jest.Mock;

  beforeEach(async () => {
    verifyAsync = jest.fn();
    messaging = {
      sendMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
      markRead: jest.fn().mockResolvedValue({ ok: true }),
      isParticipant: jest.fn().mockResolvedValue(true),
    };
    connections = {
      getAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    };
    mockedParseCookie.mockReturnValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        { provide: JwtService, useValue: { verifyAsync } },
        { provide: ConfigService, useValue: { getOrThrow: () => 'secret' } },
        { provide: MessagingService, useValue: messaging },
        { provide: ConnectionsService, useValue: connections },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    gateway = module.get(ChatGateway);
    presence = module.get(PresenceService);

    // Stub the namespace the gateway broadcasts through.
    roomEmit = jest.fn();
    disconnectSockets = jest.fn();
    // @ts-expect-error assigning the injected namespace for the test
    gateway.namespace = {
      to: jest.fn().mockReturnValue({ emit: roomEmit }),
      in: jest.fn().mockReturnValue({ disconnectSockets }),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('authenticate (via handleConnection)', () => {
    it('prefers the handshake auth token over the cookie', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: futureExp(),
      });
      mockedParseCookie.mockReturnValue({ access_token: 'COOKIE' });
      const client = makeClient({
        handshake: { auth: { token: 'AUTH' }, headers: { cookie: 'x' } },
      });

      await gateway.handleConnection(client as never);

      expect(verifyAsync).toHaveBeenCalledWith('AUTH', expect.anything());
      expect(client.data.userId).toBe('u1');
      expect(client.disconnect).not.toHaveBeenCalled();
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('falls back to the access_token cookie when no auth token is present', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u2',
        status: 'active',
        exp: futureExp(),
      });
      mockedParseCookie.mockReturnValue({ access_token: 'COOKIE' });
      const client = makeClient({
        handshake: { auth: {}, headers: { cookie: 'access_token=COOKIE' } },
      });

      await gateway.handleConnection(client as never);

      expect(verifyAsync).toHaveBeenCalledWith('COOKIE', expect.anything());
      expect(client.data.userId).toBe('u2');
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('rejects a missing/garbage token by disconnecting', async () => {
      const client = makeClient(); // no auth, cookie parse returns {}
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).toHaveBeenCalledWith(
        'exception',
        expect.objectContaining({ status: 'error' }),
      );
    });

    it('rejects an expired/invalid signature by disconnecting', async () => {
      verifyAsync.mockRejectedValue(new Error('jwt expired'));
      const client = makeClient({
        handshake: { auth: { token: 'STALE' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects a non-active member (membership enforced on the WS path)', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u3',
        status: 'pending',
        exp: futureExp(),
      });
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
    });
  });

  describe('presence transitions', () => {
    it('broadcasts online to accepted connections on first connect', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: futureExp(),
      });
      connections.getAcceptedConnectionUserIds.mockResolvedValue(['friendA']);
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      expect(gateway.namespace.to).toHaveBeenCalledWith('user:friendA');
      expect(roomEmit).toHaveBeenCalledWith('presence', {
        userId: 'u1',
        online: true,
      });
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('broadcasts offline to accepted connections when the last socket disconnects', async () => {
      connections.getAcceptedConnectionUserIds.mockResolvedValue(['friendA']);
      presence.add('u1', 'sock1');
      const client = makeClient({ data: { userId: 'u1' } });

      await gateway.handleDisconnect(client as never);

      expect(gateway.namespace.to).toHaveBeenCalledWith('user:friendA');
      expect(roomEmit).toHaveBeenCalledWith('presence', {
        userId: 'u1',
        online: false,
      });
    });

    it('emits a presence snapshot of online connections to the requester', async () => {
      connections.getAcceptedConnectionUserIds.mockResolvedValue([
        'friendA',
        'friendB',
      ]);
      presence.add('friendA', 'other-sock'); // only friendA is online
      const client = makeClient({ data: { userId: 'u1' } });

      await gateway.handlePresenceSnapshot(client as never);

      expect(client.emit).toHaveBeenCalledWith('presence:snapshot', {
        online: ['friendA'],
      });
    });
  });

  describe('token expiry', () => {
    it('disconnects the socket when the access token expires', async () => {
      jest.useFakeTimers();
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: Math.floor(Date.now() / 1000) + 1, // ~1s from the faked clock
      });
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });

      await gateway.handleConnection(client as never);
      expect(client.disconnect).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1500);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('handleTyping authorization', () => {
    it('throws when the client has not joined the conversation room', () => {
      const client = makeClient({ data: { userId: 'u1' }, rooms: new Set() });
      expect(() =>
        gateway.handleTyping(client as never, {
          conversationId: 'c1',
          isTyping: true,
        }),
      ).toThrow();
    });

    it('broadcasts typing to the room (excluding sender) once joined', () => {
      const typingEmit = jest.fn();
      const client = makeClient({
        data: { userId: 'u1' },
        rooms: new Set(['c1']),
        to: jest.fn().mockReturnValue({ emit: typingEmit }),
      });

      gateway.handleTyping(client as never, {
        conversationId: 'c1',
        isTyping: true,
      });

      expect(client.to).toHaveBeenCalledWith('c1');
      expect(typingEmit).toHaveBeenCalledWith('typing', {
        conversationId: 'c1',
        userId: 'u1',
        isTyping: true,
      });
    });
  });

  describe('handleRead', () => {
    it('delegates to messaging.markRead with the caller identity', async () => {
      const client = makeClient({ data: { userId: 'u1' } });
      await gateway.handleRead(client as never, { conversationId: 'c1' });
      expect(messaging.markRead).toHaveBeenCalledWith('c1', 'u1');
    });
  });

  describe('rate limiting', () => {
    it('eventually rejects a burst of message:send from the same user', async () => {
      const client = makeClient({ data: { userId: 'flooder' } });
      let rejected = 0;
      for (let i = 0; i < 15; i++) {
        try {
          await gateway.handleSend(client as never, {
            conversationId: 'c1',
            body: 'spam',
          });
        } catch {
          rejected++;
        }
      }
      expect(rejected).toBeGreaterThan(0);
    });
  });

  describe('force-disconnect', () => {
    it('drops all sockets in the user room on USER_SESSION_REVOKED', () => {
      gateway.handleSessionRevoked({ userId: 'u9' });
      expect(gateway.namespace.in).toHaveBeenCalledWith('user:u9');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });
  });

  describe('event broadcasts', () => {
    it('broadcasts message:new to the conversation room on MESSAGE_CREATED', () => {
      gateway.handleMessageCreated({
        conversationId: 'c1',
        message: { id: 'm1' } as never,
      });
      expect(gateway.namespace.to).toHaveBeenCalledWith('c1');
      expect(roomEmit).toHaveBeenCalledWith(
        'message:new',
        expect.objectContaining({ conversationId: 'c1' }),
      );
    });

    it('pushes notification:new to the recipient user room on NOTIFICATION_CREATED', () => {
      const notification = {
        id: 'n1',
        userId: 'u9',
        type: 'vouch_received',
        payload: { voucherId: 'u2' },
        read: false,
        createdAt: new Date(0),
      };
      gateway.handleNotificationCreated({
        userId: 'u9',
        notification,
      } as never);
      // The user room, not a conversation room — a notification is addressed to
      // one member, and reaches every tab they have open.
      expect(gateway.namespace.to).toHaveBeenCalledWith('user:u9');
      expect(roomEmit).toHaveBeenCalledWith('notification:new', notification);
    });

    it('emits the notification row itself, not the internal event envelope', () => {
      const notification = { id: 'n1', userId: 'u9', read: false };
      gateway.handleNotificationCreated({
        userId: 'u9',
        notification,
      } as never);
      const [, payload] = roomEmit.mock.calls[0] as [string, unknown];
      // The socket payload must match what GET /notifications serves, so the
      // client can treat a pushed and a fetched notification identically.
      expect(payload).not.toHaveProperty('notification');
      expect(payload).toEqual(notification);
    });

    it('does not throw before the namespace is assigned', () => {
      // @ts-expect-error simulating an event arriving pre-init
      gateway.namespace = undefined;
      expect(() =>
        gateway.handleNotificationCreated({
          userId: 'u9',
          notification: { id: 'n1' },
        } as never),
      ).not.toThrow();
    });

    it('conversation:join rejects a non-participant', async () => {
      messaging.isParticipant.mockResolvedValue(false);
      const client = makeClient({ data: { userId: 'u1' } });
      await expect(
        gateway.handleJoin(client as never, { conversationId: 'c1' }),
      ).rejects.toBeDefined();
    });

    it('message:send delegates to the single write path (no direct broadcast)', async () => {
      const client = makeClient({ data: { userId: 'u1' } });
      await gateway.handleSend(client as never, {
        conversationId: 'c1',
        body: 'hi',
      });
      expect(messaging.sendMessage).toHaveBeenCalledWith('c1', 'u1', 'hi');
    });
  });
});
