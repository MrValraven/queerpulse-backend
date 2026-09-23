// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Mocked
// exactly like `chat.gateway.spec.ts` does, since `ChatGateway` imports it at
// module scope regardless of which handlers a given test file exercises.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ConnectionsService } from '../connections/connections.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { ConversationKind } from '../messaging/entities/conversation.entity';
import { MessagingService } from '../messaging/messaging.service';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { BlockFilterService } from '../social/block-filter.service';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreferencesService } from '../preferences/preferences.service';
import { UsersService } from '../users/users.service';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';

/**
 * Task 13: the gateway's mailbox-identity parity for typing, presence and
 * the socket send path, kept in its own file to leave `chat.gateway.spec.ts`
 * exactly as it is: that file already covers the pre-mailbox shape of every
 * handler exercised here, and stays the source of truth for "a personal
 * thread is unaffected" by simply never setting up a business seat.
 */

interface FakeClient {
  id: string;
  data: Record<string, unknown>;
  rooms: Set<string>;
  handshake: { auth: { token?: string }; headers: { cookie?: string } };
  join: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  to: jest.Mock;
  leave: jest.Mock;
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

describe('ChatGateway mailbox identity parity', () => {
  let gateway: ChatGateway;
  let messaging: { sendMessage: jest.Mock };
  let connections: { allAcceptedConnectionUserIds: jest.Mock };
  let identities: {
    getById: jest.Mock;
    getByIds: jest.Mock;
    describeIdentities: jest.Mock;
    staffUserIds: jest.Mock;
    isRemovedPersona: jest.Mock;
  };
  let preferences: {
    getMessagingPrivacy: jest.Mock;
    getMessagingPrivacyForUsers: jest.Mock;
  };
  let conversationParticipants: {
    find: jest.Mock;
    manager: { findOne: jest.Mock };
  };
  let presence: PresenceService;
  /** Task 14: `identity_blocks` rows, each `[blockerUserId, identityId]`,
   *  and person blocks either way, each `[blockerId, blockedId]`. */
  let identityBlockPairs: Array<[string, string]>;
  let personBlockPairs: Array<[string, string]>;
  /** Task 14: identities that are a business here; every other resolves
   *  to a profile. */
  let businessIdentityIds: Set<string>;

  beforeEach(async () => {
    identityBlockPairs = [];
    personBlockPairs = [];
    businessIdentityIds = new Set();
    messaging = { sendMessage: jest.fn().mockResolvedValue({ id: 'm1' }) };
    connections = {
      allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    };
    identities = {
      getById: jest.fn().mockResolvedValue(null),
      // Task 13e: the live audience reads every seat's kind. Profile by
      // default, so a thread reads as personal unless a test says otherwise.
      getByIds: jest.fn((identityIds: string[]) =>
        Promise.resolve(
          identityIds.map((identityId) => ({
            id: identityId,
            kind: businessIdentityIds.has(identityId)
              ? IdentityKind.Listing
              : IdentityKind.Profile,
          })),
        ),
      ),
      describeIdentities: jest.fn().mockResolvedValue(new Map()),
      staffUserIds: jest.fn().mockResolvedValue([]),
      // No persona here was removed by moderation.
      isRemovedPersona: jest.fn().mockResolvedValue(false),
    };
    // Every fixture shares everything by default, same convention as
    // `chat.gateway.spec.ts`: none of the tests below are about PRD-364
    // sharing toggles.
    preferences = {
      getMessagingPrivacy: jest.fn().mockResolvedValue({
        shareReadReceipts: true,
        shareTyping: true,
        sharePresence: true,
        whoCanMessage: 'everyone',
      }),
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    // Task 13e: an ordinary direct thread by default; the live audience
    // relays nothing for a conversation it cannot resolve.
    conversationParticipants = {
      find: jest.fn().mockResolvedValue([]),
      manager: {
        findOne: jest.fn().mockResolvedValue({
          kind: ConversationKind.Direct,
          isOfficial: false,
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        // Task 13e: renders a mailbox thread's message frames per viewer.
        {
          provide: MessagingCoreService,
          useValue: { toMessageResponses: jest.fn() },
        },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('secret') },
        },
        { provide: MessagingService, useValue: messaging },
        { provide: ConnectionsService, useValue: connections },
        { provide: IdentitiesService, useValue: identities },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { exists: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: conversationParticipants,
        },
        {
          provide: BlockFilterService,
          useValue: {
            blockedUserIds: jest.fn((actorId: string, candidateIds: string[]) =>
              Promise.resolve(
                new Set(
                  candidateIds.filter((candidateId) =>
                    personBlockPairs.some(
                      ([blockerId, blockedId]) =>
                        (blockerId === actorId && blockedId === candidateId) ||
                        (blockerId === candidateId && blockedId === actorId),
                    ),
                  ),
                ),
              ),
            ),
            identityBlocksAmong: jest.fn(
              (blockerUserIds: string[], blockedIdentityIds: string[]) =>
                Promise.resolve(
                  identityBlockPairs
                    .filter(
                      ([blockerUserId, blockedIdentityId]) =>
                        blockerUserIds.includes(blockerUserId) &&
                        blockedIdentityIds.includes(blockedIdentityId),
                    )
                    .map(([blockerUserId, blockedIdentityId]) => ({
                      blockerUserId,
                      identityId: blockedIdentityId,
                    })),
                ),
            ),
          },
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
        { provide: PreferencesService, useValue: preferences },
      ],
    }).compile();

    gateway = module.get(ChatGateway);
    presence = module.get(PresenceService);

    // @ts-expect-error assigning the injected namespace for the test, same
    // pattern as `chat.gateway.spec.ts`.
    gateway.namespace = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      in: jest.fn().mockReturnValue({
        disconnectSockets: jest.fn(),
        socketsLeave: jest.fn(),
        fetchSockets: jest.fn().mockResolvedValue([]),
      }),
      disconnectSockets: jest.fn(),
    };
  });

  describe('typing on an identity thread', () => {
    const conversationId = 'c1';
    const identityId = 'identity-cafe-lisboa';

    beforeEach(() => {
      businessIdentityIds.add(identityId);
    });

    it('broadcasts the identity as the typist, with no human id anywhere in the frame', async () => {
      const typingEmit = jest.fn();
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const client = makeClient({
        data: { userId: 'staff1' },
        rooms: new Set([conversationId]),
        to: jest.fn().mockReturnValue({ except }),
      });
      conversationParticipants.find.mockResolvedValue([
        { userId: 'staff1', identityId },
        { userId: 'customer', identityId: 'identity-customer' },
      ]);
      identities.getById.mockResolvedValue({
        id: identityId,
        kind: IdentityKind.Listing,
      });
      identities.describeIdentities.mockResolvedValue(
        new Map([
          [
            identityId,
            {
              displayName: 'Cafe Lisboa',
              handle: 'cafe-lisboa',
              avatarUrl: null,
            },
          ],
        ]),
      );
      identities.staffUserIds.mockResolvedValue(['staff1']);

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      expect(typingEmit).toHaveBeenCalledWith('typing', {
        conversationId,
        identityId,
        displayName: 'Cafe Lisboa',
        isTyping: true,
      });
      // A field a reviewer didn't think of is where a leak hides, so this
      // checks the whole serialized frame instead of one named property.
      const [, frame] = typingEmit.mock.calls[0] as [string, unknown];
      expect(JSON.stringify(frame)).not.toContain('staff1');
      expect(JSON.stringify(frame)).not.toMatch(/"userId"/);
    });

    it('excludes every staff room of the sending identity, the whole roster', async () => {
      const typingEmit = jest.fn();
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const client = makeClient({
        data: { userId: 'staff1' },
        rooms: new Set([conversationId]),
        to: jest.fn().mockReturnValue({ except }),
      });
      conversationParticipants.find.mockResolvedValue([
        { userId: 'staff1', identityId },
        { userId: 'staff2', identityId },
        { userId: 'staff3', identityId },
        { userId: 'customer', identityId: 'identity-customer' },
      ]);
      identities.getById.mockResolvedValue({
        id: identityId,
        kind: IdentityKind.Company,
      });
      identities.describeIdentities.mockResolvedValue(
        new Map([
          [
            identityId,
            { displayName: 'Cafe Lisboa', handle: null, avatarUrl: null },
          ],
        ]),
      );
      // The full roster: three staff members, every one of them excluded so
      // the business never sees itself "typing".
      identities.staffUserIds.mockResolvedValue(['staff1', 'staff2', 'staff3']);

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      const [exclusion] = except.mock.calls[0] as [string[]];
      expect(exclusion).toEqual(
        expect.arrayContaining(['user:staff1', 'user:staff2', 'user:staff3']),
      );
      expect(exclusion).toHaveLength(3);
    });
  });

  // Task 14a: a staff member who has left the business neither speaks for
  // it nor hears it, even from a socket still sitting in the room.
  describe('typing on an identity thread, with a departed staff member', () => {
    const conversationId = 'c1';
    const identityId = 'identity-cafe-lisboa';
    const leftAt = new Date('2026-09-20T12:00:00.000Z');

    function typingClient(userId: string) {
      const typingEmit = jest.fn();
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const to = jest.fn().mockReturnValue({ except });
      const client = makeClient({
        data: { userId },
        rooms: new Set([conversationId]),
        to,
      });
      return { client, to, except, typingEmit };
    }

    beforeEach(() => {
      businessIdentityIds.add(identityId);
      identities.getById.mockResolvedValue({
        id: identityId,
        kind: IdentityKind.Listing,
      });
      identities.describeIdentities.mockResolvedValue(
        new Map([
          [
            identityId,
            { displayName: 'Cafe Lisboa', handle: null, avatarUrl: null },
          ],
        ]),
      );
      identities.staffUserIds.mockResolvedValue(['staff1']);
    });

    it('drops the business typing frame a departed staff member sends', async () => {
      const { client, to, typingEmit } = typingClient('departed-staff');
      conversationParticipants.find.mockResolvedValue([
        { userId: 'staff1', identityId, leftAt: null },
        { userId: 'departed-staff', identityId, leftAt },
        { userId: 'customer', identityId: 'identity-customer', leftAt: null },
      ]);

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      expect(to).not.toHaveBeenCalled();
      expect(typingEmit).not.toHaveBeenCalled();
    });

    it("keeps a colleague's business typing frame from the departed staff member's room", async () => {
      const { client, except, typingEmit } = typingClient('staff1');
      conversationParticipants.find.mockResolvedValue([
        { userId: 'staff1', identityId, leftAt: null },
        { userId: 'departed-staff', identityId, leftAt },
        { userId: 'customer', identityId: 'identity-customer', leftAt: null },
      ]);

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      const [exclusion] = except.mock.calls[0] as [string[]];
      expect(exclusion).toEqual(
        expect.arrayContaining(['user:staff1', 'user:departed-staff']),
      );
      expect(exclusion).not.toContain('user:customer');
      expect(typingEmit).toHaveBeenCalledTimes(1);
    });

    it('relays their typing again once they are seated again', async () => {
      const { client, typingEmit } = typingClient('departed-staff');
      identities.staffUserIds.mockResolvedValue(['staff1', 'departed-staff']);
      conversationParticipants.find.mockResolvedValue([
        { userId: 'staff1', identityId, leftAt: null },
        { userId: 'departed-staff', identityId, leftAt: null },
        { userId: 'customer', identityId: 'identity-customer', leftAt: null },
      ]);

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      expect(typingEmit).toHaveBeenCalledWith('typing', {
        conversationId,
        identityId,
        displayName: 'Cafe Lisboa',
        isTyping: true,
      });
    });
  });

  // Task 14: a staff socket still in the room after the customer blocked
  // the business, or after a person block with the customer, types to
  // nobody, whether or not the eviction has landed.
  describe('typing from a staff seat the mailbox rules exclude', () => {
    const conversationId = 'c1';
    const identityId = 'identity-cafe-lisboa';

    function staffTypingClient() {
      const typingEmit = jest.fn();
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const to = jest.fn().mockReturnValue({ except });
      const client = makeClient({
        data: { userId: 'staff1' },
        rooms: new Set([conversationId]),
        to,
      });
      return { client, to, typingEmit };
    }

    beforeEach(() => {
      businessIdentityIds.add(identityId);
      identities.getById.mockResolvedValue({
        id: identityId,
        kind: IdentityKind.Listing,
      });
      identities.describeIdentities.mockResolvedValue(
        new Map([
          [
            identityId,
            { displayName: 'Cafe Lisboa', handle: null, avatarUrl: null },
          ],
        ]),
      );
      identities.staffUserIds.mockResolvedValue(['staff1', 'staff2']);
      conversationParticipants.find.mockResolvedValue([
        { userId: 'staff1', identityId, leftAt: null },
        { userId: 'staff2', identityId, leftAt: null },
        { userId: 'customer', identityId: 'identity-customer', leftAt: null },
      ]);
    });

    it('sends the customer nothing when a staff member types after the customer blocked the business', async () => {
      identityBlockPairs = [['customer', identityId]];
      const { client, to, typingEmit } = staffTypingClient();

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      expect(to).not.toHaveBeenCalled();
      expect(typingEmit).not.toHaveBeenCalled();
    });

    it('sends the customer nothing when a staff member blocked with the customer types', async () => {
      personBlockPairs = [['customer', 'staff1']];
      const { client, to, typingEmit } = staffTypingClient();

      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      expect(to).not.toHaveBeenCalled();
      expect(typingEmit).not.toHaveBeenCalled();
    });

    it('relays the business typing again once the block is lifted', async () => {
      const { client, typingEmit } = staffTypingClient();
      identityBlockPairs = [['customer', identityId]];
      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });
      expect(typingEmit).not.toHaveBeenCalled();

      identityBlockPairs = [];
      await gateway.handleTyping(client as never, {
        conversationId,
        isTyping: true,
      });

      expect(typingEmit).toHaveBeenCalledWith('typing', {
        conversationId,
        identityId,
        displayName: 'Cafe Lisboa',
        isTyping: true,
      });
    });
  });

  describe('typing on a personal thread', () => {
    it('behaves exactly as before: frame carries userId, exclusion is the sender alone', async () => {
      const typingEmit = jest.fn();
      const except = jest.fn().mockReturnValue({ emit: typingEmit });
      const client = makeClient({
        data: { userId: 'u1' },
        rooms: new Set(['c1']),
        to: jest.fn().mockReturnValue({ except }),
      });
      // A profile-kind seat: `resolveTypingSenderIdentity` must fall through
      // to the pre-mailbox path.
      conversationParticipants.find.mockResolvedValue([
        { userId: 'u1', identityId: 'profile-identity-u1' },
        { userId: 'u2', identityId: 'profile-identity-u2' },
      ]);
      identities.getById.mockResolvedValue({
        id: 'profile-identity-u1',
        kind: IdentityKind.Profile,
      });

      await gateway.handleTyping(client as never, {
        conversationId: 'c1',
        isTyping: true,
      });

      expect(except).toHaveBeenCalledWith(['user:u1']);
      expect(typingEmit).toHaveBeenCalledWith('typing', {
        conversationId: 'c1',
        userId: 'u1',
        isTyping: true,
      });
    });
  });

  describe('presence', () => {
    it('never reports a non-profile identity as online', async () => {
      const identityId = 'identity-cafe-lisboa';
      const staffUserId = 'staff1';
      // The customer holds zero accepted connections, specifically none with
      // the staff member behind the mailbox: connections are the only input
      // `emitPresenceSnapshot`/`visibleOnlineConnectionIds` ever read from.
      connections.allAcceptedConnectionUserIds.mockResolvedValue([]);
      // The staff member's own human account IS online, and so is a
      // `conversation_participants` seat naming the business identity in a
      // thread this customer holds; neither may surface in the snapshot.
      presence.add(staffUserId, 'staff-sock');
      conversationParticipants.find.mockResolvedValue([
        { userId: 'customer1', identityId: 'profile-identity-customer1' },
        { userId: staffUserId, identityId },
      ]);
      const client = makeClient({ data: { userId: 'customer1' } });

      await gateway.handlePresenceSnapshot(client as never);

      expect(client.emit).toHaveBeenCalledWith('presence:snapshot', {
        online: [],
      });
      const [, snapshot] = client.emit.mock.calls[0] as [
        string,
        { online: string[] },
      ];
      expect(snapshot.online).not.toContain(identityId);
      expect(snapshot.online).not.toContain(staffUserId);
    });
  });

  describe('message:send identity parity', () => {
    it('rejects a socket send whose asIdentityId the caller may not act as', async () => {
      const client = makeClient({ data: { userId: 'u1' } });
      messaging.sendMessage.mockImplementation((...args: unknown[]) =>
        args[9] === 'forbidden-identity'
          ? Promise.reject(
              new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
            )
          : Promise.resolve({ id: 'm1' }),
      );

      await expect(
        gateway.handleSend(client as never, {
          conversationId: 'c1',
          body: 'hi',
          asIdentityId: 'forbidden-identity',
        }),
      ).rejects.toThrow(ForbiddenException);

      // Proves the transport actually carries `asIdentityId` through to the
      // SAME guarded call the HTTP path reaches: the value lands as the
      // final positional argument, exactly where `MessagingService.
      // sendMessage`'s signature expects it.
      expect(messaging.sendMessage).toHaveBeenCalledWith(
        'c1',
        'u1',
        'hi',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'forbidden-identity',
      );
    });
  });
});
