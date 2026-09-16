// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Mocking it
// here keeps the real module out of the transform pipeline and lets us drive
// cookie-based handshake auth deterministically.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
// Real `@sentry/node` is fine to import in a test process, but the handshake
// SERVER_ERROR tests below need to assert it was (or was not) actually
// called, which a bare import can't do without a spy.
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { parseCookie } from 'cookie';
import { ConnectionsService } from '../connections/connections.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import { MessagingService } from '../messaging/messaging.service';
import { BlockFilterService } from '../social/block-filter.service';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreferencesService } from '../preferences/preferences.service';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import { WsException } from '@nestjs/websockets';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { ChatGateway } from './chat.gateway';
import { SendMessagePayload } from './dto/chat-payloads';
import { PresenceService, PRESENCE_GRACE_WINDOW_MS } from './presence.service';

const mockedParseCookie = parseCookie as unknown as jest.Mock;
const mockedCaptureException = Sentry.captureException as jest.Mock;

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
  leave: jest.Mock;
  /** Mirrors socket.io's `Socket.connected`. Defaults to `true`; a test
   *  simulating a client that disconnected mid-handshake sets it `false`. */
  connected: boolean;
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
    leave: jest.fn(),
    connected: true,
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
  let connections: { allAcceptedConnectionUserIds: jest.Mock };
  let preferences: {
    getMessagingPrivacy: jest.Mock;
    getMessagingPrivacyForUsers: jest.Mock;
  };
  let users: { findById: jest.Mock };
  let refreshTokens: { exists: SessionExistsMock };
  let conversationParticipants: {
    find: jest.Mock;
    manager: { findOne: jest.Mock };
  };
  let blockFilter: { blockedUserIds: jest.Mock };
  let platformSettings: { get: jest.Mock };
  let configService: { getOrThrow: jest.Mock };
  let metrics: {
    incrementWebsocketConnections: jest.Mock;
    decrementWebsocketConnections: jest.Mock;
  };
  let presence: PresenceService;
  let roomEmit: jest.Mock;
  let namespaceTo: jest.Mock;
  let namespaceIn: jest.Mock;
  let socketsLeave: jest.Mock;
  let disconnectSockets: jest.Mock;
  let disconnectAllSockets: jest.Mock;
  let fetchSockets: jest.Mock;

  beforeEach(async () => {
    verifyAsync = jest.fn();
    messaging = {
      sendMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
      markRead: jest.fn().mockResolvedValue({ ok: true }),
      canJoinConversationLive: jest.fn().mockResolvedValue(true),
      directConversationIdsBetween: jest.fn().mockResolvedValue([]),
    };
    connections = {
      allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    };
    // PRD-364: every fixture shares everything by default (the platform's
    // pre-PRD-364 behaviour), so the presence/typing/read expectations below —
    // none of which anticipate the new reciprocal gating — keep passing
    // unless a test explicitly overrides these mocks.
    preferences = {
      getMessagingPrivacy: jest.fn().mockResolvedValue({
        shareReadReceipts: true,
        shareTyping: true,
        sharePresence: true,
        whoCanMessage: 'everyone',
      }),
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
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
    // Empty by default — most tests never trigger MESSAGE_CREATED's
    // per-recipient fan-out, and the ones that do set this explicitly.
    // `manager.findOne` backs the PRD-354 conversation-kind lookup
    // `fanOutConversationMessage` runs off the SAME repository's manager
    // (no separate `Conversation` repository injected). Default `null`
    // (unresolvable conversation) so it's always treated as non-GROUP,
    // matching the exact pre-PRD-354 fan-out behaviour for every existing
    // test below that doesn't care about the block filter.
    conversationParticipants = {
      find: jest.fn().mockResolvedValue([]),
      manager: { findOne: jest.fn().mockResolvedValue(null) },
    };
    // PRD-354: nobody blocked by default.
    blockFilter = { blockedUserIds: jest.fn().mockResolvedValue(new Set()) };
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        lockdownEnabled: false,
        lockdownAllowsModerators: false,
      }),
    };
    configService = { getOrThrow: jest.fn().mockReturnValue('secret') };
    metrics = {
      incrementWebsocketConnections: jest.fn(),
      decrementWebsocketConnections: jest.fn(),
    };
    mockedParseCookie.mockReturnValue({});
    mockedCaptureException.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        { provide: JwtService, useValue: { verifyAsync } },
        { provide: ConfigService, useValue: configService },
        { provide: MessagingService, useValue: messaging },
        { provide: ConnectionsService, useValue: connections },
        { provide: UsersService, useValue: users },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: conversationParticipants,
        },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: PlatformSettingsService, useValue: platformSettings },
        { provide: MetricsService, useValue: metrics },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PreferencesService, useValue: preferences },
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
    // ENG-209: `handleSessionRevoked`'s per-device path fetches the room's
    // sockets to inspect each one's `data.sessionId`. Empty by default; the
    // per-device test suite below sets it per case.
    fetchSockets = jest.fn().mockResolvedValue([]);
    namespaceIn = jest
      .fn()
      .mockReturnValue({ disconnectSockets, socketsLeave, fetchSockets });
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
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      // A failed verify is a credential failure by definition, so it must
      // never reach Sentry as though it were an infrastructure fault.
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    // `jws` (which `jsonwebtoken` sits on top of) `JSON.parse`s the token's
    // payload segment, and a genuinely malformed token can escape as a raw
    // `SyntaxError` instead of one of `jsonwebtoken`'s own error classes.
    // `authenticate` must not try to recognise the error's shape first: EVERY
    // `verifyAsync` rejection, of any type, is a credential failure.
    it('reports a malformed token that fails verification with a SyntaxError as UNAUTHORIZED', async () => {
      verifyAsync.mockRejectedValue(
        new SyntaxError('Unexpected token in JSON'),
      );
      const client = makeClient({
        handshake: { auth: { token: 'GARBAGE' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    // ENG-221: a failure reading the JWT secret is OUR infrastructure
    // problem, so it must surface as SERVER_ERROR and does belong in Sentry
    // (a bad credential never does). This is read before `jwt.verifyAsync`
    // even runs, so `verifyAsync` is never reached here.
    it('reports a JWT secret lookup failure as SERVER_ERROR', async () => {
      process.env.SENTRY_DSN = 'https://test@sentry.example/1';
      configService.getOrThrow.mockImplementation(() => {
        throw new Error('auth.jwtAccessSecret is not set');
      });
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      expect(verifyAsync).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'SERVER_ERROR',
        message: 'Internal server error',
      });
      expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error));
      delete process.env.SENTRY_DSN;
    });

    // ENG-221: same flattening bug, one layer deeper: a DB failure inside
    // the session-liveness check must not read as "your session was revoked".
    it('reports a DB failure inside assertSessionLive as SERVER_ERROR', async () => {
      process.env.SENTRY_DSN = 'https://test@sentry.example/1';
      verifyAsync.mockResolvedValue({
        sub: 'u7',
        status: 'active',
        exp: futureExp(),
        sid: 'family-x',
      });
      refreshTokens.exists.mockRejectedValue(new Error('db down'));
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'SERVER_ERROR',
        message: 'Internal server error',
      });
      expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error));
      delete process.env.SENTRY_DSN;
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
      // The credential itself verified here, so the code is SESSION_REVOKED:
      // the membership behind it is what is no longer active.
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'SESSION_REVOKED',
        message: 'Unauthorized',
      });
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
      // The MESSAGE stays generic like every other auth refusal: the client
      // learns only that it must re-authenticate. The CODE, though,
      // distinguishes "your session was revoked" from "your credential is
      // bad" (ENG-206/ENG-220), which a signed-out device's client can use to
      // stop retrying with a token refresh that will never help.
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'SESSION_REVOKED',
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
      // No `sid` on the token means no `sessionId` to store, so a later
      // `USER_SESSION_REVOKED` with a `sessionId` fails this socket CLOSED
      // instead of skipping it (see the per-device eviction suite below).
      expect(client.data.sessionId).toBeUndefined();
      expect(client.disconnect).not.toHaveBeenCalled();
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    // ENG-211: the handshake itself used to be completely unmetered, so a
    // client could disconnect and reconnect in a tight loop, paying for a JWT
    // verify, a lockdown read and a session-liveness query every time with
    // nothing to stop it.
    it('eventually rate-limits repeated handshakes from the same verified user', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'flooder',
        status: 'active',
        exp: futureExp(),
      });
      let rateLimited = 0;
      for (let i = 0; i < 15; i++) {
        const client = makeClient({
          handshake: { auth: { token: 'OK' }, headers: {} },
        });
        await gateway.handleConnection(client as never);
        const emittedCalls = client.emit.mock.calls as Array<
          [string, { code?: string } | undefined]
        >;
        const emittedFrame = emittedCalls.find(
          ([event]) => event === 'exception',
        )?.[1];
        if (emittedFrame?.code === 'RATE_LIMITED') {
          rateLimited++;
        }
        const timer = client.data.expiryTimer as NodeJS.Timeout | undefined;
        if (timer) {
          clearTimeout(timer);
        }
      }
      expect(rateLimited).toBeGreaterThan(0);
    });

    // `authenticate` awaits a JWT verify and up to two DB queries; the
    // client can disconnect somewhere in that window before any of it
    // resolves. Without the `client.connected` guard, `handleConnection`
    // would mark a socket that no longer exists as online forever and never
    // balance the connection-count metric.
    it('does not mark presence online or count the connection when the client disconnected during authenticate', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: futureExp(),
      });
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
        connected: false,
      });

      await gateway.handleConnection(client as never);

      expect(metrics.incrementWebsocketConnections).not.toHaveBeenCalled();
      expect(presence.isOnline('u1')).toBe(false);
      expect(client.join).not.toHaveBeenCalled();
    });

    // An extremely tight race: `exp` is still in the future when
    // `jwt.verifyAsync` checks it, but has slipped into the past by the time
    // `scheduleTokenExpiry` runs moments later. That immediate drop must not
    // be followed by marking the now-dead socket present.
    it('does not mark presence online when the token has already expired by the time scheduleTokenExpiry runs', async () => {
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: Math.floor(Date.now() / 1000) - 5,
      });
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'TOKEN_EXPIRED',
        message: 'Token expired',
      });
      expect(presence.isOnline('u1')).toBe(false);
    });
  });

  // socket.io-client flushes frames it buffered while disconnected the
  // instant the transport reconnects, and Nest binds these handlers without
  // awaiting `handleConnection`'s `authenticate`. A buffered frame can
  // therefore legitimately race the handshake and arrive before
  // `client.data.userId` is set.
  describe('buffered frames racing an unfinished handshake', () => {
    it('drops a typing frame with no exception frame when userId is not set yet', () => {
      const client = makeClient({ data: {} });
      expect(() =>
        gateway.handleTyping(client as never, {
          conversationId: 'c1',
          isTyping: true,
        }),
      ).not.toThrow();
      expect(client.emit).not.toHaveBeenCalled();
      expect(client.to).not.toHaveBeenCalled();
    });

    it('drops a delivered ack with no exception frame when userId is not set yet', async () => {
      const client = makeClient({ data: {} });
      await expect(
        gateway.handleDelivered(client as never, { conversationId: 'c1' }),
      ).resolves.toBeUndefined();
      expect(client.emit).not.toHaveBeenCalled();
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
        code: 'UNAUTHORIZED',
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
      connections.allAcceptedConnectionUserIds.mockResolvedValue(['friendA']);
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });

      await gateway.handleConnection(client as never);

      // One emit addressed to an ARRAY of rooms, not one emit per connection
      // (see `forceBroadcastPresence`).
      expect(namespaceTo).toHaveBeenCalledWith(['user:friendA']);
      expect(roomEmit).toHaveBeenCalledWith('presence', {
        userId: 'u1',
        online: true,
      });
      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('broadcasts offline to accepted connections when the last socket disconnects', async () => {
      connections.allAcceptedConnectionUserIds.mockResolvedValue(['friendA']);
      presence.add('u1', 'sock1');
      const client = makeClient({ data: { userId: 'u1' } });

      await gateway.handleDisconnect(client as never);

      expect(namespaceTo).toHaveBeenCalledWith(['user:friendA']);
      expect(roomEmit).toHaveBeenCalledWith('presence', {
        userId: 'u1',
        online: false,
      });
    });

    it('emits a presence snapshot of online connections to the requester', async () => {
      connections.allAcceptedConnectionUserIds.mockResolvedValue([
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
      expect(client.emit).toHaveBeenCalledWith('exception', {
        status: 'error',
        code: 'TOKEN_EXPIRED',
        message: 'Token expired',
      });
      // ENG-219: marked so `handleDisconnect` can tell this PLANNED drop
      // apart from a genuine one and grant `PresenceService` a grace window.
      expect(client.data.isExpiring).toBe(true);
    });

    // ENG-219: a reconnect within the grace window must not flap the member
    // offline, since `PushMessageListener` reads `PresenceService.isOnline`
    // directly, so a spurious offline blip here would push a DM the member
    // never actually stopped looking at.
    it('grants a grace window instead of broadcasting offline on the planned token-expiry drop', async () => {
      jest.useFakeTimers();
      connections.allAcceptedConnectionUserIds.mockResolvedValue(['friendA']);
      verifyAsync.mockResolvedValue({
        sub: 'u1',
        status: 'active',
        exp: Math.floor(Date.now() / 1000) + 1,
      });
      const client = makeClient({
        handshake: { auth: { token: 'OK' }, headers: {} },
      });
      await gateway.handleConnection(client as never);
      roomEmit.mockClear();

      jest.advanceTimersByTime(1500); // scheduleTokenExpiry fires
      await gateway.handleDisconnect(client as never);

      // No offline broadcast yet: the grace window has not elapsed.
      expect(roomEmit).not.toHaveBeenCalledWith(
        'presence',
        expect.objectContaining({ online: false }),
      );
      expect(presence.isOnline('u1')).toBe(true);

      jest.advanceTimersByTime(PRESENCE_GRACE_WINDOW_MS);
      // `onGraceExpired` fires `broadcastPresence`, which chains THREE
      // `await`s before it emits (its own PRD-364 `getMessagingPrivacy` gate,
      // then `forceBroadcastPresence`'s `allAcceptedConnectionUserIds` and
      // `getMessagingPrivacyForUsers`), so three microtask-queue flushes are
      // needed for that chain to settle, not two.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(roomEmit).toHaveBeenCalledWith('presence', {
        userId: 'u1',
        online: false,
      });
      expect(presence.isOnline('u1')).toBe(false);
    });
  });

  describe('handleTyping authorization', () => {
    it('does not broadcast typing when the client has not joined the conversation room', async () => {
      const client = makeClient({ data: { userId: 'u1' }, rooms: new Set() });
      // A socket not yet in the room silently no-ops rather than throwing (a
      // benign pre-join race — the composer re-emits typing every ~2s), but the
      // security invariant still holds: it never broadcasts into a room it hasn't
      // joined.
      await expect(
        gateway.handleTyping(client as never, {
          conversationId: 'c1',
          isTyping: true,
        }),
      ).resolves.not.toThrow();
      expect(client.to).not.toHaveBeenCalled();
    });

    it('broadcasts typing to the room (excluding sender) once joined', async () => {
      const typingEmit = jest.fn();
      // The gateway chains `.to(room).except([...]).emit(...)` so a member
      // signed in on two devices never sees their own typing frame echoed back.
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const client = makeClient({
        data: { userId: 'u1' },
        rooms: new Set(['c1']),
        to: jest.fn().mockReturnValue({ except }),
      });

      await gateway.handleTyping(client as never, {
        conversationId: 'c1',
        isTyping: true,
      });

      expect(client.to).toHaveBeenCalledWith('c1');
      // Sender's own room, plus (PRD-364) any other participant who has
      // turned off typing sharing — empty here, since `conversationParticipants`
      // defaults to `[]`.
      expect(except).toHaveBeenCalledWith(['user:u1']);
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

    // ENG-163: `conversation:join`, `read` and `presence:snapshot` used to
    // carry no bucket at all, the one transport the HTTP ThrottlerGuard
    // never reaches.
    //
    // ENG-207: `conversation:join` no longer THROWS for this refusal (see
    // the dedicated ack-shape tests below), so a burst is observed by
    // reading the returned ack, with no exception to catch.
    it('eventually returns a RATE_LIMITED ack for a burst of conversation:join from the same user', async () => {
      const client = makeClient({ data: { userId: 'flooder' } });
      let rateLimited = 0;
      for (let i = 0; i < 15; i++) {
        const ack = await gateway.handleJoin(client as never, {
          conversationId: 'c1',
        });
        if (!ack.ok && ack.code === 'RATE_LIMITED') {
          rateLimited++;
        }
      }
      expect(rateLimited).toBeGreaterThan(0);
    });

    // ENG-217: `conversation:leave` mirrors `conversation:join`'s ack shape.
    it('eventually returns a RATE_LIMITED ack for a burst of conversation:leave from the same user', async () => {
      const client = makeClient({ data: { userId: 'flooder' } });
      let rateLimited = 0;
      for (let i = 0; i < 15; i++) {
        const ack = gateway.handleLeave(client as never, {
          conversationId: 'c1',
        });
        if (!ack.ok && ack.code === 'RATE_LIMITED') {
          rateLimited++;
        }
      }
      expect(rateLimited).toBeGreaterThan(0);
    });

    it('eventually rejects a burst of read from the same user', async () => {
      const client = makeClient({ data: { userId: 'flooder' } });
      let rejected = 0;
      for (let i = 0; i < 30; i++) {
        try {
          await gateway.handleRead(client as never, { conversationId: 'c1' });
        } catch (err) {
          expect(err).toBeInstanceOf(WsException);
          rejected++;
        }
      }
      expect(rejected).toBeGreaterThan(0);
    });

    it('eventually rejects a burst of presence:snapshot from the same user', async () => {
      const client = makeClient({ data: { userId: 'flooder' } });
      let rejected = 0;
      for (let i = 0; i < 10; i++) {
        try {
          await gateway.handlePresenceSnapshot(client as never);
        } catch (err) {
          expect(err).toBeInstanceOf(WsException);
          rejected++;
        }
      }
      expect(rejected).toBeGreaterThan(0);
    });

    // ENG-211: a disconnect must NOT reset a bucket that is still mid-drain.
    // That reset was itself the bypass (exhaust the bucket, disconnect,
    // reconnect, start over on a fresh one). Only `sweepIdle` (a periodic
    // sweep, exercised in `ws-rate-limiter.spec.ts`) may reclaim a bucket,
    // and only once it has fully refilled.
    it('does not reset an exhausted bucket when the socket disconnects', async () => {
      const userId = 'flooder-disconnect';
      const client = makeClient({ data: { userId } });
      presence.add(userId, client.id);

      // Drain the send bucket.
      let sawRateLimit = false;
      for (let i = 0; i < 15; i++) {
        try {
          await gateway.handleSend(client as never, {
            conversationId: 'c1',
            body: 'spam',
          });
        } catch {
          sawRateLimit = true;
        }
      }
      expect(sawRateLimit).toBe(true);

      // The socket's last connection drops; before ENG-211 this cleared the
      // bucket outright.
      await gateway.handleDisconnect(client as never);

      // A fresh socket for the SAME user (the immediate reconnect a flooding
      // client would do) must still find the bucket rate-limited.
      const reconnectedClient = makeClient({ data: { userId } });
      await expect(
        gateway.handleSend(reconnectedClient as never, {
          conversationId: 'c1',
          body: 'still spamming',
        }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });
  });

  describe('force-disconnect', () => {
    // The `SESSION_REVOKED` frame is TERMINAL on the frontend (reconnection
    // is switched off), so it may only go to a socket the gateway can
    // POSITIVELY identify as the revoked one. Without a `sessionId` this
    // event cannot single out which (if any) of the member's sockets are
    // actually revoked: a single-device `/auth/logout`, "log out other
    // devices", a suspension and the 60s sweep all reach this path. The
    // whole room gets a PLAIN disconnect with no frame instead, and each
    // socket's own reconnect handshake re-authenticates and decides the
    // truth from there.
    it('drops the whole room with a plain disconnect and no exception frame on a blanket USER_SESSION_REVOKED (no sessionId)', async () => {
      await gateway.handleSessionRevoked({ userId: 'u9' });

      expect(namespaceIn).toHaveBeenCalledWith('user:u9');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
      expect(namespaceTo).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
      expect(fetchSockets).not.toHaveBeenCalled();
    });

    // ENG-209: "sign out this device" now targets only the sockets whose
    // handshake token was minted for the revoked session family, so the
    // member's other signed-in devices stay connected.
    describe('per-device eviction (sessionId present)', () => {
      const revokedFrame = {
        status: 'error',
        code: 'SESSION_REVOKED',
        message: 'This device was signed out',
      };

      it('drops only the socket whose sessionId matches the revoked family, and tells only it', async () => {
        const matchingSocket = {
          data: { sessionId: 'fam-revoked' },
          emit: jest.fn(),
          disconnect: jest.fn(),
        };
        const otherDeviceSocket = {
          data: { sessionId: 'fam-other-device' },
          emit: jest.fn(),
          disconnect: jest.fn(),
        };
        fetchSockets.mockResolvedValue([matchingSocket, otherDeviceSocket]);

        await gateway.handleSessionRevoked({
          userId: 'u9',
          sessionId: 'fam-revoked',
        });

        expect(matchingSocket.emit).toHaveBeenCalledWith(
          'exception',
          revokedFrame,
        );
        expect(matchingSocket.disconnect).toHaveBeenCalledWith(true);
        // The other, positively-identified-as-different device is left
        // completely alone: no frame, no disconnect.
        expect(otherDeviceSocket.emit).not.toHaveBeenCalled();
        expect(otherDeviceSocket.disconnect).not.toHaveBeenCalled();
        // The blanket path must not ALSO run: only one device is targeted.
        expect(disconnectSockets).not.toHaveBeenCalled();
      });

      // A legacy socket cannot be told apart from the revoked device, so it
      // is disconnected defensively, but WITHOUT the terminal frame: it may
      // genuinely be a different, uninvolved device, and a plain disconnect
      // sends it through an ordinary reconnect whose own handshake decides
      // the truth (see `assertSessionLive`).
      it('fails closed and drops a legacy socket with no sessionId at all, without telling it SESSION_REVOKED', async () => {
        const legacySocket = {
          data: {}, // no `sessionId`: a token minted before the `sid` claim
          emit: jest.fn(),
          disconnect: jest.fn(),
        };
        fetchSockets.mockResolvedValue([legacySocket]);

        await gateway.handleSessionRevoked({
          userId: 'u9',
          sessionId: 'fam-revoked',
        });

        expect(legacySocket.emit).not.toHaveBeenCalled();
        expect(legacySocket.disconnect).toHaveBeenCalledWith(true);
      });
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

    // ENG-160: `message:new` above only reaches sockets that JOINED the
    // conversation room. A member who has a different thread open (or is
    // elsewhere in the app entirely) never joins it, so without this
    // per-recipient fan-out they got no badge bump, no inbox row, and no
    // in-app signal until a remount/reload.
    describe('ENG-160 conversation:message fan-out', () => {
      // The fan-out is fire-and-forget off the sync `handleMessageCreated`
      // handler and now chains up to three internal `await`s (participants,
      // the PRD-354 conversation-kind lookup, and, for a GROUP, the block
      // filter), so a fixed count of `await Promise.resolve()` ticks is
      // fragile; a macrotask flush reliably drains every pending microtask
      // ahead of it regardless of how many internal awaits it has.
      const flushFanOut = () => new Promise((resolve) => setImmediate(resolve));

      it('signals every other active participant on their user room, not the sender', async () => {
        conversationParticipants.find.mockResolvedValue([
          { userId: 'sender', leftAt: null },
          { userId: 'recipient', leftAt: null },
        ]);
        const response = { id: 'm1', conversationId: 'c1' };

        gateway.handleMessageCreated({
          conversationId: 'c1',
          message: { senderId: 'sender' } as never,
          response: response as never,
        });
        await flushFanOut();

        expect(namespaceTo).toHaveBeenCalledWith('user:recipient');
        expect(roomEmit).toHaveBeenCalledWith('conversation:message', {
          conversationId: 'c1',
          message: response,
        });
        expect(namespaceTo).not.toHaveBeenCalledWith('user:sender');
      });

      // ENG-239: the default full-row `find` used to pull every participant
      // column (including each member's own possibly-5000-char `draft`) for
      // every participant of every single send.
      it('selects only userId and leftAt off the participants query (ENG-239)', async () => {
        conversationParticipants.find.mockResolvedValue([
          { userId: 'sender', leftAt: null },
        ]);

        gateway.handleMessageCreated({
          conversationId: 'c1',
          message: { senderId: 'sender' } as never,
          response: { id: 'm1' } as never,
        });
        await flushFanOut();

        expect(conversationParticipants.find).toHaveBeenCalledWith({
          where: { conversationId: 'c1' },
          select: { userId: true, leftAt: true },
        });
      });

      it('skips a participant who left the conversation', async () => {
        conversationParticipants.find.mockResolvedValue([
          { userId: 'sender', leftAt: null },
          { userId: 'departed', leftAt: new Date() },
        ]);

        gateway.handleMessageCreated({
          conversationId: 'c1',
          message: { senderId: 'sender' } as never,
          response: { id: 'm1' } as never,
        });
        await flushFanOut();

        expect(namespaceTo).not.toHaveBeenCalledWith('user:departed');
      });

      // PRD-354: a block does not dissolve a GROUP, so without this a
      // blocked-either-way member kept getting a live signal for everything
      // the blocked sender posted.
      it('skips a GROUP participant blocked either way with the sender (PRD-354)', async () => {
        conversationParticipants.find.mockResolvedValue([
          { userId: 'sender', leftAt: null },
          { userId: 'blocked-member', leftAt: null },
          { userId: 'ordinary-member', leftAt: null },
        ]);
        conversationParticipants.manager.findOne.mockResolvedValue({
          id: 'g1',
          kind: ConversationKind.Group,
        });
        blockFilter.blockedUserIds.mockResolvedValue(
          new Set(['blocked-member']),
        );

        gateway.handleMessageCreated({
          conversationId: 'g1',
          message: { senderId: 'sender' } as never,
          response: { id: 'm1' } as never,
        });
        await flushFanOut();

        expect(conversationParticipants.manager.findOne).toHaveBeenCalledWith(
          Conversation,
          { where: { id: 'g1' }, select: { kind: true } },
        );
        expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('sender', [
          'sender',
          'blocked-member',
          'ordinary-member',
        ]);
        expect(namespaceTo).not.toHaveBeenCalledWith('user:blocked-member');
        expect(namespaceTo).toHaveBeenCalledWith('user:ordinary-member');
      });

      it('never runs the block filter for a DM (non-GROUP conversation)', async () => {
        conversationParticipants.find.mockResolvedValue([
          { userId: 'sender', leftAt: null },
          { userId: 'recipient', leftAt: null },
        ]);
        conversationParticipants.manager.findOne.mockResolvedValue({
          id: 'c1',
          kind: ConversationKind.Direct,
        });

        gateway.handleMessageCreated({
          conversationId: 'c1',
          message: { senderId: 'sender' } as never,
          response: { id: 'm1' } as never,
        });
        await flushFanOut();

        expect(blockFilter.blockedUserIds).not.toHaveBeenCalled();
        expect(namespaceTo).toHaveBeenCalledWith('user:recipient');
      });

      it('swallows a participant-lookup failure rather than throwing', async () => {
        conversationParticipants.find.mockRejectedValue(new Error('db down'));

        expect(() =>
          gateway.handleMessageCreated({
            conversationId: 'c1',
            message: { senderId: 'sender' } as never,
            response: { id: 'm1' } as never,
          }),
        ).not.toThrow();
        await flushFanOut();
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

    // ENG-207: a refusal returns as an ACK instead of a thrown exception; see
    // the "rate limiting" suite above for the RATE_LIMITED half of this ack.
    it('conversation:join returns a FORBIDDEN ack for a non-participant', async () => {
      messaging.canJoinConversationLive.mockResolvedValue(false);
      const client = makeClient({ data: { userId: 'u1' } });
      await expect(
        gateway.handleJoin(client as never, { conversationId: 'c1' }),
      ).resolves.toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(client.join).not.toHaveBeenCalled();
    });

    // Also covers a left/removed group participant and a blocked DM
    // counterpart — both refused by `canJoinConversationLive` itself
    // (unit-tested in messaging.service.spec.ts); this only proves the
    // gateway wires the boolean through to the ack.
    it('conversation:join succeeds when canJoinConversationLive allows it', async () => {
      messaging.canJoinConversationLive.mockResolvedValue(true);
      const client = makeClient({ data: { userId: 'u1' } });
      await expect(
        gateway.handleJoin(client as never, { conversationId: 'c1' }),
      ).resolves.toEqual({ ok: true, joined: 'c1' });
      expect(client.join).toHaveBeenCalledWith('c1');
    });

    describe('conversation:leave (ENG-217)', () => {
      it('leaves the room and acks without any DB work', () => {
        const client = makeClient({ data: { userId: 'u1' } });
        const ack = gateway.handleLeave(client as never, {
          conversationId: 'c1',
        });
        expect(ack).toEqual({ ok: true, left: 'c1' });
        expect(messaging.canJoinConversationLive).not.toHaveBeenCalled();
      });
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
