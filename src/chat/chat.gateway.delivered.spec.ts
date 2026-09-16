// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Same
// module mock `chat.gateway.spec.ts` uses; these tests never read a cookie.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));

import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ConnectionsService } from '../connections/connections.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { MessagingService } from '../messaging/messaging.service';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { UsersService } from '../users/users.service';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';

/** The delivered bucket's burst allowance (`deliveredLimiter.capacity`). */
const DELIVERED_BURST_CAPACITY = 20;
const FROZEN_NOW = new Date('2026-09-15T09:00:00.000Z').getTime();

interface FakeClient {
  id: string;
  data: Record<string, unknown>;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

function makeClient(userId?: string): FakeClient {
  return {
    id: `socket-${userId ?? 'anonymous'}`,
    data: userId ? { userId } : {},
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

/**
 * `delivered` acks and their `message:delivered` relay, beyond the
 * pre-handshake drop `chat.gateway.spec.ts` already covers. The testing
 * module is built the same way that spec builds it.
 */
describe('ChatGateway delivered receipts', () => {
  let gateway: ChatGateway;
  let messaging: { markDelivered: jest.Mock };
  let roomEmit: jest.Mock;
  let namespaceTo: jest.Mock;
  let dateNow: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    messaging = { markDelivered: jest.fn().mockResolvedValue({ ok: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('secret') },
        },
        { provide: MessagingService, useValue: messaging },
        {
          provide: ConnectionsService,
          useValue: {
            getAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: UsersService,
          useValue: { findById: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { exists: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: getRepositoryToken(ConversationParticipant),
          // `manager.findOne` backs the PRD-354 conversation-kind lookup
          // `fanOutConversationMessage` runs (see `chat.gateway.spec.ts`'s own
          // comment); unused by this file's delivered-ack/relay paths, but
          // required for the gateway to construct at all.
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            manager: { findOne: jest.fn().mockResolvedValue(null) },
          },
        },
        {
          provide: BlockFilterService,
          // PRD-354: unused by this file's delivered-ack/relay paths (see the
          // `PreferencesService` comment below for the same reasoning).
          useValue: { blockedUserIds: jest.fn().mockResolvedValue(new Set()) },
        },
        {
          provide: PlatformSettingsService,
          useValue: {
            get: jest.fn().mockResolvedValue({
              lockdownEnabled: false,
              lockdownAllowsModerators: false,
            }),
          },
        },
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
          // PRD-364: unused by `delivered` acks (this file's only path under
          // test) — the methods `ChatGateway` reads are on typing/read/
          // presence paths only.
          useValue: {
            getMessagingPrivacy: jest.fn(),
            getMessagingPrivacyForUsers: jest.fn(),
          },
        },
      ],
    }).compile();
    gateway = module.get(ChatGateway);

    roomEmit = jest.fn();
    namespaceTo = jest.fn().mockReturnValue({ emit: roomEmit });
    (gateway as unknown as { namespace: unknown }).namespace = {
      to: namespaceTo,
    };

    // The token bucket reads `Date.now()`; freezing it means no token refills
    // mid-burst, so the burst arithmetic below is exact.
    dateNow = jest.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function sendAcks(
    client: FakeClient,
    count: number,
    conversationId = 'c1',
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await expect(
        gateway.handleDelivered(client as never, { conversationId }),
      ).resolves.toBeUndefined();
    }
  }

  it('persists the ack under the handshake identity, ignoring any user id smuggled into the payload', async () => {
    const client = makeClient('u1');

    await gateway.handleDelivered(
      client as never,
      { conversationId: 'c1', userId: 'someone-else' } as never,
    );

    expect(messaging.markDelivered).toHaveBeenCalledWith('c1', 'u1');
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('does not reach messaging for a buffered ack that races the handshake', async () => {
    const client = makeClient();

    await expect(
      gateway.handleDelivered(client as never, { conversationId: 'c1' }),
    ).resolves.toBeUndefined();

    expect(messaging.markDelivered).not.toHaveBeenCalled();
  });

  it('drops acks past the burst allowance silently, with no exception frame', async () => {
    const client = makeClient('flooder');

    await sendAcks(client, DELIVERED_BURST_CAPACITY + 5);

    expect(messaging.markDelivered).toHaveBeenCalledTimes(
      DELIVERED_BURST_CAPACITY,
    );
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('persists acks again once the bucket has refilled', async () => {
    const client = makeClient('flooder');
    await sendAcks(client, DELIVERED_BURST_CAPACITY + 1);
    expect(messaging.markDelivered).toHaveBeenCalledTimes(
      DELIVERED_BURST_CAPACITY,
    );

    // One second at the sustained refill rate buys at least one more token.
    dateNow.mockReturnValue(FROZEN_NOW + 1000);
    await sendAcks(client, 1);

    expect(messaging.markDelivered).toHaveBeenCalledTimes(
      DELIVERED_BURST_CAPACITY + 1,
    );
  });

  it("keeps one member's exhausted bucket from swallowing another member's acks", async () => {
    await sendAcks(makeClient('flooder'), DELIVERED_BURST_CAPACITY + 5);
    messaging.markDelivered.mockClear();

    await sendAcks(makeClient('bystander'), 1);

    expect(messaging.markDelivered).toHaveBeenCalledWith('c1', 'bystander');
  });

  it("lets markDelivered's participation refusal propagate so the exception filter frames it", async () => {
    messaging.markDelivered.mockRejectedValue(
      new ForbiddenException('You have left this conversation'),
    );

    await expect(
      gateway.handleDelivered(makeClient('u1') as never, {
        conversationId: 'c1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('relays the stored watermark to that conversation room only', () => {
    const payload = {
      conversationId: 'c1',
      userId: 'recipient',
      deliveredAt: new Date('2026-09-15T09:30:00.000Z'),
    };

    gateway.handleMessageDelivered(payload);

    expect(namespaceTo).toHaveBeenCalledTimes(1);
    expect(namespaceTo).toHaveBeenCalledWith('c1');
    expect(roomEmit).toHaveBeenCalledWith('message:delivered', payload);
  });
});
