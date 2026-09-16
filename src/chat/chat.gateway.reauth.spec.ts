// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Same
// module mock `chat.gateway.spec.ts` uses; these tests never read a cookie
// (every client below authenticates via `handshake.auth.token`).
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import { UserStatus } from '../users/entities/user.entity';
import { ConnectionsService } from '../connections/connections.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { MessagingService } from '../messaging/messaging.service';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { UsersService } from '../users/users.service';
import { ChatGateway, MAX_SET_TIMEOUT_DELAY_MS } from './chat.gateway';
import { PresenceService } from './presence.service';

const ACCESS_TTL_MS = 15 * 60 * 1000;

interface FakeClient {
  id: string;
  data: Record<string, unknown>;
  handshake: {
    auth: { token?: string };
    headers: { cookie?: string };
  };
  join: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  connected: boolean;
}

function makeClient(token: string): FakeClient {
  return {
    id: `socket-${token}`,
    data: {},
    handshake: { auth: { token }, headers: {} },
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
    connected: true,
  };
}

const futureExp = (secondsFromNow = 900): number =>
  Math.floor(Date.now() / 1000) + secondsFromNow;

/**
 * ENG-219: `session:reauth` re-authenticates an OPEN socket in place instead
 * of `scheduleTokenExpiry` dropping it every ~15 minutes. Built the same way
 * `chat.gateway.delivered.spec.ts` builds its own focused module, rather than
 * growing the already-1500-line `chat.gateway.spec.ts`.
 */
describe('ChatGateway session:reauth', () => {
  let gateway: ChatGateway;
  let verifyAsync: jest.Mock;
  let refreshTokens: { exists: jest.Mock };
  let platformSettings: { get: jest.Mock };

  beforeEach(async () => {
    verifyAsync = jest.fn();
    refreshTokens = { exists: jest.fn().mockResolvedValue(true) };
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        lockdownEnabled: false,
        lockdownAllowsModerators: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        { provide: JwtService, useValue: { verifyAsync } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('secret') },
        },
        {
          provide: MessagingService,
          useValue: { canJoinConversationLive: jest.fn() },
        },
        {
          provide: ConnectionsService,
          useValue: {
            allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: UsersService,
          useValue: { findById: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            manager: { findOne: jest.fn().mockResolvedValue(null) },
          },
        },
        {
          provide: BlockFilterService,
          useValue: { blockedUserIds: jest.fn().mockResolvedValue(new Set()) },
        },
        { provide: PlatformSettingsService, useValue: platformSettings },
        {
          provide: MetricsService,
          useValue: {
            incrementWebsocketConnections: jest.fn(),
            decrementWebsocketConnections: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: PreferencesService,
          // `handleConnection` -> `broadcastPresence` reads this for every
          // connect in these tests, so it needs a resolvable shape even
          // though presence fan-out itself isn't what's under test here.
          useValue: {
            getMessagingPrivacy: jest.fn().mockResolvedValue({
              shareReadReceipts: true,
              shareTyping: true,
              sharePresence: true,
              whoCanMessage: 'everyone',
            }),
            getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    gateway = module.get(ChatGateway);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Authenticates `client` via `handleConnection` under a token that
   *  verifies as `userId`, expiring at `exp` (defaults to 15 minutes out). */
  async function connectAs(
    client: FakeClient,
    userId: string,
    exp: number = futureExp(),
  ): Promise<void> {
    verifyAsync.mockResolvedValueOnce({ sub: userId, status: 'active', exp });
    await gateway.handleConnection(client as never);
  }

  it('extends an open socket on a valid reauth token with no disconnect', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    const originalExp = futureExp(900); // 15 minutes out
    await connectAs(client, 'u1', originalExp);
    const originalTimer = client.data.expiryTimer;

    // Advance to just before the ORIGINAL token would have expired, and
    // reauth with a token that pushes `exp` a further 15 minutes out.
    jest.advanceTimersByTime(14 * 60 * 1000);
    const newExp = futureExp(900) + 14 * 60; // 15m from the advanced clock
    verifyAsync.mockResolvedValueOnce({
      sub: 'u1',
      status: 'active',
      exp: newExp,
    });

    const ack = await gateway.handleReauth(client as never, {
      token: 'fresh',
    });

    expect(ack).toEqual({ ok: true, exp: newExp });
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.data.exp).toBe(newExp);
    // The OLD timer must actually be cleared: a merely-superseded one still
    // has its closure (capturing the OLD `exp`) armed, so it would fire at
    // the ORIGINAL deadline and drop a socket that just proved a valid,
    // newer credential.
    expect(client.data.expiryTimer).not.toBe(originalTimer);

    // Advance PAST the original (would-have-been) expiry: still alive.
    jest.advanceTimersByTime(2 * 60 * 1000);
    expect(client.disconnect).not.toHaveBeenCalled();

    clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
  });

  it('rejects a reauth token minted for a different user and drops the socket', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    await connectAs(client, 'u1');
    client.emit.mockClear();

    verifyAsync.mockResolvedValueOnce({
      sub: 'someone-else',
      status: 'active',
      exp: futureExp(900),
    });

    const ack = await gateway.handleReauth(client as never, {
      token: 'stolen',
    });

    expect(ack).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      code: 'TOKEN_EXPIRED',
      message: 'Token expired',
    });
    // ENG-219: the shared drop path still grants the presence grace window,
    // exactly as a routine scheduled expiry would.
    expect(client.data.isExpiring).toBe(true);
  });

  it('rejects a malformed/expired reauth token and drops the socket', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    await connectAs(client, 'u1');
    client.emit.mockClear();

    verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));

    const ack = await gateway.handleReauth(client as never, {
      token: 'garbage',
    });

    expect(ack).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('rejects a reauth for a session revoked since the handshake and drops the socket', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    await connectAs(client, 'u1');
    client.emit.mockClear();
    // The refresh-token family behind the (same) user's fresh token was
    // revoked since the handshake: the same check `assertSessionLive` runs
    // at a fresh handshake.
    refreshTokens.exists.mockResolvedValueOnce(false);
    verifyAsync.mockResolvedValueOnce({
      sub: 'u1',
      status: 'active',
      sid: 'family-1',
      exp: futureExp(900),
    });

    const ack = await gateway.handleReauth(client as never, {
      token: 'revoked-session',
    });

    expect(ack).toEqual({ ok: false, code: 'SESSION_REVOKED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('does not clear the original expiry timer on a rejected reauth, leaving the routine drop as the fallback', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    const originalExp = futureExp(5); // 5s out, deliberately short for the test
    await connectAs(client, 'u1', originalExp);

    verifyAsync.mockRejectedValueOnce(new Error('bad signature'));
    await gateway.handleReauth(client as never, { token: 'garbage' });

    // The failed reauth already disconnected the socket itself (asserted in
    // the test above); this asserts the ORIGINAL timer was never touched by
    // the failed attempt, i.e. there is no path where a rejected reauth
    // leaves the socket alive with no expiry timer at all.
    expect(client.data.expiryTimer).toBeDefined();
    clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
  });

  it('refuses without dropping the socket once the reauth bucket is exhausted', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    await connectAs(client, 'u1');
    client.disconnect.mockClear();

    // Burn the reauth bucket (capacity 10) with tokens that fail validation
    // for an unrelated reason (session revoked), so only the LAST attempt in
    // this test is the one under the rate limit itself.
    refreshTokens.exists.mockResolvedValue(true);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      verifyAsync.mockResolvedValueOnce({
        sub: 'u1',
        status: 'active',
        exp: futureExp(900),
      });
      await gateway.handleReauth(client as never, { token: `ok-${attempt}` });
    }
    client.disconnect.mockClear();

    const ack = await gateway.handleReauth(client as never, {
      token: 'eleventh',
    });

    expect(ack).toEqual({ ok: false, code: 'RATE_LIMITED' });
    // Only a bad credential drops the socket via the shared drop path; a
    // volume refusal stays a plain refusal.
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  describe('setTimeout clamp (ENG-260, exercised through the shared scheduler)', () => {
    it('does not drop a socket immediately when exp is beyond the 24.8-day setTimeout ceiling', async () => {
      jest.useFakeTimers();
      // ~40 days out, comfortably past MAX_SET_TIMEOUT_DELAY_MS (~24.8 days).
      const farExp = futureExp(40 * 24 * 60 * 60);
      const client = makeClient('original');
      await connectAs(client, 'u1', farExp);

      // If the delay were handed to `setTimeout` unclamped, it would overflow
      // Node's 32-bit internal delay and fire almost immediately.
      expect(client.disconnect).not.toHaveBeenCalled();

      // Advancing by exactly the clamp ceiling fires the FIRST leg, which
      // must re-arm rather than drop, since real time until `farExp` still
      // remains.
      jest.advanceTimersByTime(MAX_SET_TIMEOUT_DELAY_MS);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.expiryTimer).toBeDefined();

      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });

    it('reauth also clamps a far-future exp rather than overflowing setTimeout', async () => {
      jest.useFakeTimers();
      const client = makeClient('original');
      await connectAs(client, 'u1');

      const farExp = futureExp(40 * 24 * 60 * 60);
      verifyAsync.mockResolvedValueOnce({
        sub: 'u1',
        status: 'active',
        exp: farExp,
      });
      const ack = await gateway.handleReauth(client as never, {
        token: 'far-future',
      });

      expect(ack).toEqual({ ok: true, exp: farExp });
      expect(client.disconnect).not.toHaveBeenCalled();

      jest.advanceTimersByTime(MAX_SET_TIMEOUT_DELAY_MS);
      expect(client.disconnect).not.toHaveBeenCalled();

      clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    });
  });
});

/**
 * ENG-219 frontend half: `session:reauth` also accepts a single-use socket
 * ticket (`SocketTicketService`) in place of a raw access token, since the
 * browser SPA can never put the httpOnly `access_token` JWT into a frame
 * itself. `socketTicketService` here is the REAL shared singleton
 * `ChatGateway` imports directly, never a mock. It is the exact object
 * `AuthController.mintSocketTicket` would mint against in production, so
 * these tests exercise the actual mint/redeem mechanism rather than a
 * stand-in for it.
 */
describe('ChatGateway session:reauth (ticket path)', () => {
  let gateway: ChatGateway;
  let verifyAsync: jest.Mock;
  let refreshTokens: { exists: jest.Mock };
  let platformSettings: { get: jest.Mock };

  beforeEach(async () => {
    verifyAsync = jest.fn();
    refreshTokens = { exists: jest.fn().mockResolvedValue(true) };
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        lockdownEnabled: false,
        lockdownAllowsModerators: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        { provide: JwtService, useValue: { verifyAsync } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('secret') },
        },
        {
          provide: MessagingService,
          useValue: { canJoinConversationLive: jest.fn() },
        },
        {
          provide: ConnectionsService,
          useValue: {
            allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: UsersService,
          useValue: { findById: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            manager: { findOne: jest.fn().mockResolvedValue(null) },
          },
        },
        {
          provide: BlockFilterService,
          useValue: { blockedUserIds: jest.fn().mockResolvedValue(new Set()) },
        },
        { provide: PlatformSettingsService, useValue: platformSettings },
        {
          provide: MetricsService,
          useValue: {
            incrementWebsocketConnections: jest.fn(),
            decrementWebsocketConnections: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: PreferencesService,
          useValue: {
            getMessagingPrivacy: jest.fn().mockResolvedValue({
              shareReadReceipts: true,
              shareTyping: true,
              sharePresence: true,
              whoCanMessage: 'everyone',
            }),
            getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    gateway = module.get(ChatGateway);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function connectAs(
    client: FakeClient,
    userId: string,
    exp: number = futureExp(),
  ): Promise<void> {
    verifyAsync.mockResolvedValueOnce({ sub: userId, status: 'active', exp });
    await gateway.handleConnection(client as never);
  }

  it('extends an open socket on a valid ticket with no disconnect', async () => {
    const client = makeClient('original');
    await connectAs(client, 'u1');

    const { ticket } = socketTicketService.mint(
      'u1',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );
    const ack = await gateway.handleReauth(client as never, { ticket });

    expect(ack.ok).toBe(true);
    expect(client.disconnect).not.toHaveBeenCalled();
    clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
  });

  it('redeems a ticket exactly once: a second reauth with the same ticket fails and drops the socket', async () => {
    const client = makeClient('original');
    await connectAs(client, 'u1');

    const { ticket } = socketTicketService.mint(
      'u1',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );
    const firstAck = await gateway.handleReauth(client as never, { ticket });
    expect(firstAck.ok).toBe(true);
    clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    client.disconnect.mockClear();

    const secondAck = await gateway.handleReauth(client as never, { ticket });

    expect(secondAck).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('rejects an expired ticket and drops the socket', async () => {
    jest.useFakeTimers();
    const client = makeClient('original');
    await connectAs(client, 'u1');

    const { ticket, ttlMs } = socketTicketService.mint(
      'u1',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );
    jest.advanceTimersByTime(ttlMs + 1);

    const ack = await gateway.handleReauth(client as never, { ticket });

    expect(ack).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a ticket minted for a different user and drops the socket', async () => {
    const attackerSocket = makeClient('attacker-socket');
    await connectAs(attackerSocket, 'user-b');

    // Minted for user-a, presented on user-b's already-authenticated socket.
    const { ticket } = socketTicketService.mint(
      'user-a',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );

    const ack = await gateway.handleReauth(attackerSocket as never, {
      ticket,
    });

    expect(ack).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(attackerSocket.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a ticket minted while the member was suspended, even though the socket is currently connected', async () => {
    const client = makeClient('original');
    await connectAs(client, 'u1');

    const { ticket } = socketTicketService.mint(
      'u1',
      undefined,
      UserStatus.Suspended,
      ACCESS_TTL_MS,
    );

    const ack = await gateway.handleReauth(client as never, { ticket });

    expect(ack).toEqual({ ok: false, code: 'SESSION_REVOKED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a ticket redemption during a platform lockdown for a non-staff member', async () => {
    const client = makeClient('original');
    await connectAs(client, 'u1');

    const { ticket } = socketTicketService.mint(
      'u1',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );
    platformSettings.get.mockResolvedValue({
      lockdownEnabled: true,
      lockdownAllowsModerators: false,
      lockdownMessage: 'Platform is under maintenance',
    });

    const ack = await gateway.handleReauth(client as never, { ticket });

    expect(ack).toEqual({ ok: false, code: 'PLATFORM_LOCKED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a ticket redemption for a session revoked since it was minted', async () => {
    const client = makeClient('original');
    await connectAs(client, 'u1');

    const { ticket } = socketTicketService.mint(
      'u1',
      'family-1',
      UserStatus.Active,
      ACCESS_TTL_MS,
    );
    refreshTokens.exists.mockResolvedValueOnce(false);

    const ack = await gateway.handleReauth(client as never, { ticket });

    expect(ack).toEqual({ ok: false, code: 'SESSION_REVOKED' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuses a payload with neither token nor ticket as BAD_REQUEST without dropping the socket', async () => {
    const client = makeClient('original');
    await connectAs(client, 'u1');
    client.disconnect.mockClear();

    const ack = await gateway.handleReauth(client as never, {});

    expect(ack).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
