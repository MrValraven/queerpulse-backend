// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Mocking it
// here keeps the real module out of the transform pipeline and lets us drive
// cookie-based handshake auth deterministically.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { parseCookie } from 'cookie';
import { ConnectionsService } from '../connections/connections.service';
import { MessagingService } from '../messaging/messaging.service';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import { WsException } from '@nestjs/websockets';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { ChatGateway } from './chat.gateway';
import { SendMessagePayload } from './dto/chat-payloads';
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

/**
 * The refresh-token liveness probe the handshake makes, typed on the one field
 * a test reads back. Naming the arguments lets a test inspect the call without
 * pulling them out of `any`.
 */
type SessionExistsMock = jest.Mock<
  Promise<boolean>,
  [{ where: { familyId: string } }]
>;

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let verifyAsync: jest.Mock;
  let messaging: {
    sendMessage: jest.Mock;
    markRead: jest.Mock;
    canJoinConversationLive: jest.Mock;
    directConversationIdsBetween: jest.Mock;
  };
  let connections: { getAcceptedConnectionUserIds: jest.Mock };
  let users: { findById: jest.Mock };
  let refreshTokens: { exists: SessionExistsMock };
  let platformSettings: { get: jest.Mock };
  let presence: PresenceService;
  let roomEmit: jest.Mock;
  let namespaceTo: jest.Mock;
  let namespaceIn: jest.Mock;
  let socketsLeave: jest.Mock;
  let disconnectSockets: jest.Mock;
  let disconnectAllSockets: jest.Mock;

  beforeEach(async () => {
    verifyAsync = jest.fn();
    messaging = {
      sendMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
      markRead: jest.fn().mockResolvedValue({ ok: true }),
      canJoinConversationLive: jest.fn().mockResolvedValue(true),
      directConversationIdsBetween: jest.fn().mockResolvedValue([]),
    };
    connections = {
      getAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    };
    // Lockdown off by default so existing auth/presence/etc. tests are
    // unaffected by the Task 8 check — `findById` is never even reached
    // unless a test flips `lockdownEnabled` to true.
    users = { findById: jest.fn().mockResolvedValue(null) };
    // Live session by default. Tokens in most tests below carry no `sid` at
    // all, so the gateway never even asks. See the legacy-token test.
    refreshTokens = {
      exists: (jest.fn() as SessionExistsMock).mockResolvedValue(true),
    };
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        lockdownEnabled: false,
        lockdownAllowsModerators: false,
      }),
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
        { provide: UsersService, useValue: users },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        { provide: PlatformSettingsService, useValue: platformSettings },
        {
          provide: MetricsService,
          useValue: {
            incrementWebsocketConnections: jest.fn(),
            decrementWebsocketConnections: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    gateway = module.get(ChatGateway);
    presence = module.get(PresenceService);

    // Stub the namespace the gateway broadcasts through.
    roomEmit = jest.fn();
    disconnectSockets = jest.fn();
    disconnectAllSockets = jest.fn();
    namespaceTo = jest.fn().mockReturnValue({ emit: roomEmit });
    socketsLeave = jest.fn();
    namespaceIn = jest
      .fn()
      .mockReturnValue({ disconnectSockets, socketsLeave });
    // @ts-expect-error assigning the injected namespace for the test
    gateway.namespace = {
      to: namespaceTo,
      in: namespaceIn,
      // Namespace-level (not room-scoped) — the blanket lockdown disconnect.
      disconnectSockets: disconnectAllSockets,
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

    // ENG-19, socket half. `USER_SESSION_REVOKED` drops the member's open
    // sockets once; without these three the signed-out device just reconnected
    // on the access token it still held and was admitted for the rest of its
    // TTL. The rules mirror `JwtStrategy.isSessionLive` exactly, because a
    // device refused over HTTP and admitted over the socket is the same bug.
    it('refuses a handshake whose session family has been revoked', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u4',
        status: 'active',
        exp: futureExp(),
        sid: 'family-revoked',
      });
      refreshTokens.exists.mockResolvedValue(false);
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      expect(refreshTokens.exists).toHaveBeenCalledTimes(1);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
      expect(client.join).not.toHaveBeenCalled();
      // Generic, like every other auth refusal: the client learns it must
      // re-authenticate, and nothing more.
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        message: 'Unauthorized',
      });
    });

    it('admits a handshake whose session family is still live', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u5',
        status: 'active',
        exp: futureExp(),
        sid: 'family-live',
      });
      refreshTokens.exists.mockResolvedValue(true);
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      expect(refreshTokens.exists).toHaveBeenCalledTimes(1);
      expect(refreshTokens.exists.mock.calls[0]?.[0].where.familyId).toBe(
        'family-live',
      );
      expect(client.data.userId).toBe('u5');
      expect(client.disconnect).not.toHaveBeenCalled();
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('admits a legacy token that carries no session claim, without querying', async () => {
      // Access tokens minted before the `sid` deploy stay valid for the rest of
      // their TTL. Refusing them would have signed every member out the moment
      // the deploy landed.
      verifyAsync.mockResolvedValue({
        sub: 'u6',
        status: 'active',
        exp: futureExp(),
      });
      const client = makeClient({
        handshake: { auth: { token: 'LEGACY' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      expect(refreshTokens.exists).not.toHaveBeenCalled();
      expect(client.data.userId).toBe('u6');
      expect(client.disconnect).not.toHaveBeenCalled();
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });
  });

  // The same matrix PlatformLockdownGuard's spec runs, repeated here because
  // the WS path enforces the rule independently — the global guard skips
  // non-HTTP contexts entirely.
  describe('platform lockdown (handshake)', () => {
    const lock = (flags: Record<string, unknown> = {}) =>
      platformSettings.get.mockResolvedValue({
        lockdownEnabled: true,
        lockdownAllowsModerators: false,
        lockdownMessage: null,
        ...flags,
      });

    const connectAs = async (role?: UserRole) => {
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: futureExp(),
      });
      users.findById.mockResolvedValue(role ? { id: 'u1', role } : null);
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      return client;
    };

    it('refuses a member while locked down', async () => {
      lock();
      const client = await connectAs(UserRole.Member);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
      expect(client.join).not.toHaveBeenCalled();
    });

    it('allows an admin while locked down', async () => {
      lock();
      const client = await connectAs(UserRole.Admin);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.userId).toBe('u1');
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('refuses a moderator while locked down when moderators are not allowed', async () => {
      lock({ lockdownAllowsModerators: false });
      const client = await connectAs(UserRole.Moderator);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
    });

    it('allows a moderator while locked down when moderators are allowed', async () => {
      lock({ lockdownAllowsModerators: true });
      const client = await connectAs(UserRole.Moderator);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.userId).toBe('u1');
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('refuses a member even when moderators are allowed through', async () => {
      lock({ lockdownAllowsModerators: true });
      const client = await connectAs(UserRole.Member);

      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('allows a member when lockdown is off, without looking the user up', async () => {
      // Lockdown off is the default mock; the DB read must be skipped entirely.
      const client = await connectAs(UserRole.Member);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.userId).toBe('u1');
      expect(users.findById).not.toHaveBeenCalled();
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('fails closed when the user row is gone (deleted mid-session)', async () => {
      // No row means no role, and an absent role is not staff — the token alone
      // must never be enough to walk through a lockdown.
      lock({ lockdownAllowsModerators: true });
      const client = await connectAs(undefined);

      expect(users.findById).toHaveBeenCalledWith('u1');
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.userId).toBeUndefined();
    });

    it('tells the client it was a lockdown, not an auth failure', async () => {
      // Otherwise socket.io auto-reconnect + token refresh loops for the whole
      // lockdown, and the admin's message never reaches the member.
      lock({ lockdownMessage: 'Back in an hour.' });
      const client = await connectAs(UserRole.Member);

      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'PLATFORM_LOCKED',
        message: 'Back in an hour.',
      });
    });

    it('falls back to the default copy when the admin message is empty', async () => {
      lock({ lockdownMessage: '' });
      const client = await connectAs(UserRole.Member);

      expect(client.emit).toHaveBeenCalledWith(
        'exception',
        expect.objectContaining({
          code: 'PLATFORM_LOCKED',
          message: expect.stringContaining('temporarily unavailable') as string,
        }),
      );
    });

    it('keeps every other rejection generic', async () => {
      // Widening the lockdown payload must not widen what a bad token reveals.
      verifyAsync.mockRejectedValue(new Error('jwt expired'));
      const client = makeClient({
        handshake: { auth: { token: 'STALE' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        message: 'Unauthorized',
      });
    });

    it('disconnects every live socket when lockdown is switched on', () => {
      gateway.handleLockdownEnabled({ actorId: 'admin-1' });

      expect(disconnectAllSockets).toHaveBeenCalledWith(true);
    });

    it('does not throw before the namespace is assigned', () => {
      // @ts-expect-error simulating the event arriving pre-init
      gateway.namespace = undefined;
      expect(() =>
        gateway.handleLockdownEnabled({ actorId: 'admin-1' }),
      ).not.toThrow();
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

      expect(namespaceTo).toHaveBeenCalledWith('user:friendA');
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

      expect(namespaceTo).toHaveBeenCalledWith('user:friendA');
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
    it('does not broadcast typing when the client has not joined the conversation room', () => {
      const client = makeClient({ data: { userId: 'u1' }, rooms: new Set() });
      // A socket not yet in the room silently no-ops rather than throwing (a
      // benign pre-join race — the composer re-emits typing every ~2s), but the
      // security invariant still holds: it never broadcasts into a room it hasn't
      // joined.
      expect(() =>
        gateway.handleTyping(client as never, {
          conversationId: 'c1',
          isTyping: true,
        }),
      ).not.toThrow();
      expect(client.to).not.toHaveBeenCalled();
    });

    it('broadcasts typing to the room (excluding sender) once joined', () => {
      const typingEmit = jest.fn();
      // The gateway chains `.to(room).except('user:<id>').emit(...)` so a member
      // signed in on two devices never sees their own typing frame echoed back.
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const client = makeClient({
        data: { userId: 'u1' },
        rooms: new Set(['c1']),
        to: jest.fn().mockReturnValue({ except }),
      });

      gateway.handleTyping(client as never, {
        conversationId: 'c1',
        isTyping: true,
      });

      expect(client.to).toHaveBeenCalledWith('c1');
      expect(except).toHaveBeenCalledWith('user:u1');
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
      expect(messaging.markRead).toHaveBeenCalledWith('c1', 'u1', {
        upToMessageId: undefined,
      });
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
      expect(namespaceIn).toHaveBeenCalledWith('user:u9');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });
  });

  describe('room eviction (BE-MSG-01)', () => {
    // Room authorisation happens ONCE, at `conversation:join`; every later
    // broadcast is a blind room emit. Losing access therefore has to actively
    // push the member's sockets out of the room.
    it('evicts a removed/left member from the conversation room, without dropping their other sockets', () => {
      gateway.handleConversationMembershipRevoked({
        conversationId: 'c1',
        userIds: ['u9'],
      });
      expect(namespaceIn).toHaveBeenCalledWith('user:u9');
      expect(socketsLeave).toHaveBeenCalledWith('c1');
      // Only this room is cut: their notifications, presence and other
      // conversations stay live.
      expect(disconnectSockets).not.toHaveBeenCalled();
    });

    it('evicts BOTH sides of a blocked pair from every DM room they share', async () => {
      messaging.directConversationIdsBetween.mockResolvedValue(['c1', 'c2']);

      await gateway.handleMemberBlocked({
        blockerId: 'blocker',
        blockedId: 'blocked',
      });

      expect(messaging.directConversationIdsBetween).toHaveBeenCalledWith(
        'blocker',
        'blocked',
      );
      expect(namespaceIn).toHaveBeenCalledWith('user:blocker');
      expect(namespaceIn).toHaveBeenCalledWith('user:blocked');
      expect(socketsLeave).toHaveBeenCalledWith('c1');
      expect(socketsLeave).toHaveBeenCalledWith('c2');
      expect(socketsLeave).toHaveBeenCalledTimes(4);
    });

    it('swallows a lookup failure rather than rejecting a block that already committed', async () => {
      messaging.directConversationIdsBetween.mockRejectedValue(
        new Error('db down'),
      );
      await expect(
        gateway.handleMemberBlocked({
          blockerId: 'blocker',
          blockedId: 'blocked',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('event broadcasts', () => {
    it('broadcasts the frontend-contract response (not the internal view) as message:new', () => {
      const response = { id: 'm1', conversationId: 'c1' };
      gateway.handleMessageCreated({
        conversationId: 'c1',
        message: { id: 'm1' } as never,
        response: response as never,
      });
      expect(namespaceTo).toHaveBeenCalledWith('c1');
      // The room receives the hydrated `response`, so clients patch it straight
      // into the thread cache and reconcile the optimistic bubble by client id.
      expect(roomEmit).toHaveBeenCalledWith('message:new', {
        conversationId: 'c1',
        message: response,
      });
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
      expect(namespaceTo).toHaveBeenCalledWith('user:u9');
      // The mapped response DTO (M6), never the raw entity: the socket payload
      // matches what GET /notifications serves, and its `payload` is the
      // allowlist projection — `voucherId` (a raw user id) is not a
      // `vouch_received` display field, so it is stripped.
      expect(roomEmit).toHaveBeenCalledWith('notification:new', {
        id: 'n1',
        userId: 'u9',
        type: 'vouch_received',
        payload: {},
        read: false,
        createdAt: new Date(0),
        actor: null,
        // Bundling count. An ordinary row carries none, and the mapper
        // defaults it to 0 rather than leaving the field off the wire.
        otherActorCount: 0,
      });
    });

    it('emits the mapped notification row, not the internal event envelope', () => {
      const notification = {
        id: 'n1',
        userId: 'u9',
        type: 'mention',
        // A community-post mention carries the gated body as `excerpt`; it must
        // never cross the wire (M6 backstops H3).
        payload: {
          actorId: 'u2',
          source: 'community',
          communitySlug: 'private-support',
          entityKind: 'member',
          excerpt: 'a private thing said inside a private community',
        },
        read: false,
        createdAt: new Date(0),
      };
      gateway.handleNotificationCreated({
        userId: 'u9',
        notification,
      } as never);
      const [, payload] = roomEmit.mock.calls[0] as [
        string,
        { payload: Record<string, unknown> },
      ];
      // Not the internal `{ userId, notification }` envelope — the row itself,
      // so the client treats a pushed and a fetched notification identically.
      expect(payload).not.toHaveProperty('notification');
      expect(payload.payload).not.toHaveProperty('excerpt');
      expect(payload.payload).toEqual({
        source: 'community',
        communitySlug: 'private-support',
        entityKind: 'member',
      });
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
      messaging.canJoinConversationLive.mockResolvedValue(false);
      const client = makeClient({ data: { userId: 'u1' } });
      await expect(
        gateway.handleJoin(client as never, { conversationId: 'c1' }),
      ).rejects.toBeDefined();
    });

    // Also covers a left/removed group participant and a blocked DM
    // counterpart — both refused by `canJoinConversationLive` itself
    // (unit-tested in messaging.service.spec.ts); this only proves the
    // gateway wires the boolean through to a WsException.
    it('conversation:join succeeds when canJoinConversationLive allows it', async () => {
      messaging.canJoinConversationLive.mockResolvedValue(true);
      const client = makeClient({ data: { userId: 'u1' } });
      await expect(
        gateway.handleJoin(client as never, { conversationId: 'c1' }),
      ).resolves.toEqual({ joined: 'c1' });
      expect(client.join).toHaveBeenCalledWith('c1');
    });

    it('message:send delegates to the single write path (no direct broadcast)', async () => {
      const client = makeClient({ data: { userId: 'u1' } });
      await gateway.handleSend(client as never, {
        conversationId: 'c1',
        body: 'hi',
      });
      // The WS send path forwards the full message signature (reply/clientId/
      // forwarded/kind/attachment), all undefined for a plain text send here.
      expect(messaging.sendMessage).toHaveBeenCalledWith(
        'c1',
        'u1',
        'hi',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  // ENG-48: the socket and `POST /conversations/:id/messages` reach the same
  // `MessagingService.sendMessage`, so they must validate the same. These read
  // the pipe off the gateway's own class metadata (rather than building a
  // second one here) so the assertions cannot pass against a pipe the gateway
  // does not actually use.
  describe('validation contract (shared with HTTP)', () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const bodyMetadata: ArgumentMetadata = {
      type: 'body',
      metatype: SendMessagePayload,
    };

    function gatewayPipe(): ValidationPipe {
      const pipes = Reflect.getMetadata(PIPES_METADATA, ChatGateway) as
        ValidationPipe[] | undefined;
      const pipe = pipes?.[0];
      if (!pipe) {
        throw new Error('ChatGateway declares no @UsePipes validation pipe');
      }
      return pipe;
    }

    it('carries the same options the global HTTP pipe uses', () => {
      // forbidNonWhitelisted in particular: without it the socket silently
      // STRIPPED an unknown key that HTTP answers with a 400.
      expect(VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted).toBe(true);
      expect(VALIDATION_PIPE_OPTIONS.whitelist).toBe(true);
    });

    it('accepts the declared send payload', async () => {
      const validated = (await gatewayPipe().transform(
        { conversationId, body: 'hi' },
        bodyMetadata,
      )) as SendMessagePayload;
      expect(validated.body).toBe('hi');
      expect(validated.conversationId).toBe(conversationId);
    });

    it('rejects an unknown key instead of silently dropping it', async () => {
      await expect(
        gatewayPipe().transform(
          // A plausible client typo: the DTO field is `replyToId`. Dropped
          // silently, the message persisted with no reply reference at all.
          { conversationId, body: 'hi', replyTo: conversationId },
          bodyMetadata,
        ),
      ).rejects.toBeInstanceOf(WsException);
    });

    it('leaves omitted optional fields off the instance entirely', async () => {
      // `exposeUnsetFields: false` rides along with the shared options; the
      // handlers only read named fields, so this is behaviour-neutral here, but
      // assert it so a future WS DTO fed through Object.assign is not a surprise.
      const validated = await gatewayPipe().transform(
        { conversationId, body: 'hi' },
        bodyMetadata,
      );
      expect(Object.prototype.hasOwnProperty.call(validated, 'replyToId')).toBe(
        false,
      );
      expect(
        Object.prototype.hasOwnProperty.call(validated, 'attachment'),
      ).toBe(false);
    });
  });
});
