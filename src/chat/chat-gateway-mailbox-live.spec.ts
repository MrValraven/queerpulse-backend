// The `cookie` package (v2) is ESM-only, which ts-jest cannot load. Mocked
// exactly like `chat.gateway.spec.ts` does.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ConnectionsService } from '../connections/connections.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from '../messaging/entities/message-reaction.entity';
import type { MessageResponse } from '../messaging/message-response';
import { MessagingService } from '../messaging/messaging.service';
import { isCoveredByMailboxStaffFloor } from '../messaging/mailbox-seats';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { UsersService } from '../users/users.service';
import { ChatGateway } from './chat.gateway';
import { MailboxTypingAggregator } from './mailbox-typing-aggregator';
import { PresenceService } from './presence.service';

/**
 * Task 13e: live frames on a business mailbox thread, asserted on what each
 * viewer's sockets RECEIVE. The namespace below is a small in-memory stand-in
 * for socket.io: every socket belongs to one user, sits in that user's
 * `user:<id>` room and in whichever conversation rooms it joined, and a room
 * emit reaches exactly the sockets in the room. A frame counts as received
 * by a user when any of that user's sockets got it, whichever route it took.
 *
 * Cafe Lisboa is a listing mailbox staffed by Tiago, Ana and Rui. Marta is
 * the customer. Every assertion about the customer serializes everything
 * Marta received and searches it for each staff member's name, handle,
 * avatar and user id.
 */

const CONVERSATION_ID = 'c-mailbox';
const PERSONAL_CONVERSATION_ID = 'c-personal';
const CUSTOMER_USER_ID = 'customer-marta';
const CUSTOMER_IDENTITY_ID = 'identity-marta';
const MAILBOX_IDENTITY_ID = 'identity-cafe-lisboa';
const FRIEND_USER_ID = 'friend-joana';
const FRIEND_IDENTITY_ID = 'identity-joana';
/** Task 14: a second business Tiago also answers for. */
const OTHER_BUSINESS_CONVERSATION_ID = 'c-other-business';
const OTHER_MAILBOX_IDENTITY_ID = 'identity-tiago-studio';

interface StaffMember {
  userId: string;
  firstName: string;
  handle: string;
  avatarUrl: string;
}

const TIAGO: StaffMember = {
  userId: 'staff-tiago',
  firstName: 'Tiago',
  handle: 'tiago-costa',
  avatarUrl: 'https://example.test/tiago.png',
};
const ANA: StaffMember = {
  userId: 'staff-ana',
  firstName: 'Ana',
  handle: 'ana-sousa',
  avatarUrl: 'https://example.test/ana.png',
};
const RUI: StaffMember = {
  userId: 'staff-rui',
  firstName: 'Rui',
  handle: 'rui-lopes',
  avatarUrl: 'https://example.test/rui.png',
};
const STAFF = [TIAGO, ANA, RUI];

/** Every string that would tell the customer which human answered. */
const STAFF_IDENTIFYING_STRINGS = STAFF.flatMap((member) => [
  member.userId,
  member.firstName,
  member.handle,
  member.avatarUrl,
]);

const BUSINESS_SENDER = {
  handle: 'cafe-lisboa',
  displayName: 'Cafe Lisboa',
  pronouns: null,
  avatarUrl: 'https://example.test/cafe.png',
  identityId: MAILBOX_IDENTITY_ID,
  identityKind: IdentityKind.Listing,
};

function seat(
  userId: string,
  identityId: string,
  overrides: Partial<ConversationParticipant> = {},
): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId,
    leftAt: null,
    lastReadAt: null,
    deliveredAt: null,
    clearedAt: null,
    historyFloorAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

/**
 * Stand-in for `MessagingCoreService.toMessageResponses`, shaped like the
 * real renderer's output (`renderMessageSender`): a staff reader sees the
 * business with the colleague's first name, the customer sees the business
 * alone, and each reader gets their own viewer-specific flags.
 */
function renderForViewer(
  message: { id: string; senderId: string | null; body: string },
  viewerId: string,
): MessageResponse {
  const author = STAFF.find((member) => member.userId === message.senderId);
  const isStaffViewer = STAFF.some((member) => member.userId === viewerId);
  const sender = author
    ? {
        ...BUSINESS_SENDER,
        ...(isStaffViewer ? { staffFirstName: author.firstName } : {}),
      }
    : {
        handle: 'marta-silva',
        displayName: 'Marta Silva',
        pronouns: null,
        avatarUrl: null,
      };
  return {
    id: message.id,
    conversationId: CONVERSATION_ID,
    body: message.body,
    sender,
    viewerMarker: viewerId === CUSTOMER_USER_ID ? 'customer' : 'staff',
    canEdit: message.senderId === viewerId,
  } as unknown as MessageResponse;
}

interface FakeSocket {
  id: string;
  data: { userId: string };
  rooms: Set<string>;
  emit: jest.Mock;
  to: (room: string) => RoomOperator;
}

interface RoomOperator {
  except: (rooms: string | string[]) => RoomOperator;
  emit: (event: string, frame: unknown) => void;
}

/** The in-memory socket.io stand-in described at the top of this file. */
class FakeNamespace {
  readonly sockets: FakeSocket[] = [];

  connect(userId: string, joinedRooms: string[] = []): FakeSocket {
    const socket: FakeSocket = {
      id: `socket-${userId}-${this.sockets.length}`,
      data: { userId },
      rooms: new Set([`user:${userId}`, ...joinedRooms]),
      emit: jest.fn(),
      to: (room) => this.operator([room], new Set(), socket),
    };
    this.sockets.push(socket);
    return socket;
  }

  to(room: string | string[]): RoomOperator {
    return this.operator(Array.isArray(room) ? room : [room], new Set());
  }

  in(room: string) {
    const socketsInRoom = () =>
      this.sockets.filter((socket) => socket.rooms.has(room));
    return {
      fetchSockets: () => Promise.resolve(socketsInRoom()),
      socketsLeave: (leftRoom: string) => {
        for (const socket of socketsInRoom()) {
          socket.rooms.delete(leftRoom);
        }
      },
      disconnectSockets: jest.fn(),
    };
  }

  disconnectSockets = jest.fn();

  private operator(
    rooms: string[],
    exceptedRooms: Set<string>,
    sendingSocket?: FakeSocket,
  ): RoomOperator {
    return {
      except: (excepted) => {
        const merged = new Set(exceptedRooms);
        for (const room of Array.isArray(excepted) ? excepted : [excepted]) {
          merged.add(room);
        }
        return this.operator(rooms, merged, sendingSocket);
      },
      emit: (event, frame) => {
        for (const socket of this.sockets) {
          const isAddressed = rooms.some((room) => socket.rooms.has(room));
          const isExcepted = [...exceptedRooms].some((room) =>
            socket.rooms.has(room),
          );
          if (isAddressed && !isExcepted && socket !== sendingSocket) {
            socket.emit(event, frame);
          }
        }
      },
    };
  }

  /** Every `[event, frame]` any of `userId`'s sockets received. */
  receivedBy(userId: string): Array<[string, unknown]> {
    return this.sockets
      .filter((socket) => socket.data.userId === userId)
      .flatMap((socket) => socket.emit.mock.calls as Array<[string, unknown]>);
  }

  framesOf(userId: string, event: string): unknown[] {
    return this.receivedBy(userId)
      .filter(([receivedEvent]) => receivedEvent === event)
      .map(([, frame]) => frame);
  }
}

function staffStringsIn(frames: unknown): string[] {
  const serialized = JSON.stringify(frames);
  return STAFF_IDENTIFYING_STRINGS.filter((value) =>
    serialized.includes(value),
  );
}

function whereValue(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (value instanceof FindOperator) return value.value as unknown[];
  return [value];
}

describe('ChatGateway live frames on a business mailbox thread (Task 13e)', () => {
  let gateway: ChatGateway;
  let namespace: FakeNamespace;
  let seats: ConversationParticipant[];
  let identityKinds: Map<string, IdentityKind>;
  let blockedPairs: Array<[string, string]>;
  /** Task 14: `identity_blocks` rows, each `[blockerUserId, identityId]`. */
  let identityBlockPairs: Array<[string, string]>;
  let reactionRows: Array<{
    messageId: string;
    userId: string;
    key: MessageReactionKey;
  }>;
  let messageRows: Map<
    string,
    {
      id: string;
      senderId: string | null;
      body: string;
      // Task 13h: read by the `loadMailboxStaffFlooredUserIds` stand-in alone.
      createdAt?: Date;
      replyToId?: string | null;
    }
  >;
  let messaging: {
    canJoinConversationLive: jest.Mock;
    directConversationIdsBetween: jest.Mock;
  };
  let toMessageResponses: jest.Mock;
  let loadMailboxStaffFlooredUserIds: jest.Mock;
  // CW-09: a direct handle on `conversationParticipants.find`, exposed
  // outside the `beforeEach` closure that builds it, so a test can count
  // how many times a single `handleTyping` frame queries it.
  let conversationParticipantsFind: jest.Mock;
  // CW-12: a direct handle on `IdentitiesService.getById`, so a test can
  // make it stand in for the DB latency a lone typist's frame awaits
  // between the timestamp capture and `MailboxTypingAggregator.record`.
  let identitiesGetById: jest.Mock;
  /** Persona identities moderation removed (`subprofiles.removed_at` set). */
  let removedPersonaIdentityIds: Set<string>;

  beforeEach(async () => {
    namespace = new FakeNamespace();
    seats = [
      seat(TIAGO.userId, MAILBOX_IDENTITY_ID),
      seat(CUSTOMER_USER_ID, CUSTOMER_IDENTITY_ID),
      seat(ANA.userId, MAILBOX_IDENTITY_ID),
      seat(RUI.userId, MAILBOX_IDENTITY_ID),
      seat(CUSTOMER_USER_ID, CUSTOMER_IDENTITY_ID, {
        conversationId: PERSONAL_CONVERSATION_ID,
      }),
      seat(FRIEND_USER_ID, FRIEND_IDENTITY_ID, {
        conversationId: PERSONAL_CONVERSATION_ID,
      }),
    ];
    removedPersonaIdentityIds = new Set();
    identityKinds = new Map([
      [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
      [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
      [FRIEND_IDENTITY_ID, IdentityKind.Profile],
      [OTHER_MAILBOX_IDENTITY_ID, IdentityKind.Company],
    ]);
    blockedPairs = [];
    identityBlockPairs = [];
    reactionRows = [];
    messageRows = new Map();
    messaging = {
      canJoinConversationLive: jest.fn().mockResolvedValue(true),
      directConversationIdsBetween: jest.fn().mockResolvedValue([]),
    };
    toMessageResponses = jest.fn(
      (
        rows: Array<{ id: string; senderId: string | null; body: string }>,
        viewerId: string,
      ) => Promise.resolve(rows.map((row) => renderForViewer(row, viewerId))),
    );
    // Task 13h: stand-in for
    // `MessagingCoreService.loadMailboxStaffFlooredUserIds`, answered from
    // the seats' `historyFloorAt`, their identity kinds and the messages'
    // `createdAt` through the rule's in-memory twin,
    // `isCoveredByMailboxStaffFloor`.
    loadMailboxStaffFlooredUserIds = jest.fn(
      (conversationId: string, messageId: string) => {
        const createdAt = messageRows.get(messageId)?.createdAt;
        const conversation = conversations.get(conversationId);
        return Promise.resolve(
          new Set(
            seats
              .filter(
                (candidate) =>
                  candidate.conversationId === conversationId &&
                  createdAt !== undefined &&
                  isCoveredByMailboxStaffFloor(createdAt, {
                    historyFloorAt: candidate.historyFloorAt,
                    identityKind: identityKinds.get(candidate.identityId),
                    isGroupConversation:
                      conversation?.kind === ConversationKind.Group,
                    isOfficialConversation: conversation?.isOfficial ?? false,
                  }),
              )
              .map((candidate) => candidate.userId),
          ),
        );
      },
    );

    const conversations = new Map([
      [
        CONVERSATION_ID,
        {
          id: CONVERSATION_ID,
          kind: ConversationKind.Direct,
          isOfficial: false,
        },
      ],
      [
        PERSONAL_CONVERSATION_ID,
        {
          id: PERSONAL_CONVERSATION_ID,
          kind: ConversationKind.Direct,
          isOfficial: false,
        },
      ],
      [
        OTHER_BUSINESS_CONVERSATION_ID,
        {
          id: OTHER_BUSINESS_CONVERSATION_ID,
          kind: ConversationKind.Direct,
          isOfficial: false,
        },
      ],
    ]);

    // Stand-in for `identityBlockEvictions`'s SQL (Task 14): the direct,
    // non-official conversations where the blocker sits on a profile
    // identity and some seat speaks for the blocked identity.
    const identityBlockedThreadIds = (parameters: Record<string, string>) =>
      [...conversations.values()]
        .filter((conversation) => {
          const threadSeats = seats.filter(
            (candidate) => candidate.conversationId === conversation.id,
          );
          return (
            conversation.kind !== ConversationKind.Group &&
            !conversation.isOfficial &&
            threadSeats.some(
              (candidate) =>
                candidate.userId === parameters.blockerUserId &&
                identityKinds.get(candidate.identityId) ===
                  IdentityKind.Profile,
            ) &&
            threadSeats.some(
              (candidate) =>
                candidate.identityId === parameters.blockedIdentityId,
            )
          );
        })
        .map((conversation) => ({ conversationId: conversation.id }));

    // Stand-in for `mailboxEvictionsForBlock`'s SQL: the direct,
    // non-official conversations both users sit in that seat a mailbox
    // identity. It reads the same fixture the SQL would.
    const sharedMailboxThreadQuery = () => {
      const parameters: Record<string, string> = {};
      const builder = {
        select: () => builder,
        innerJoin: (
          _entity: unknown,
          _alias: string,
          _condition: string,
          joinParameters?: Record<string, string>,
        ) => {
          Object.assign(parameters, joinParameters);
          return builder;
        },
        where: (
          _condition: string,
          whereParameters?: Record<string, string>,
        ) => {
          Object.assign(parameters, whereParameters);
          return builder;
        },
        andWhere: () => builder,
        getRawMany: () =>
          Promise.resolve(
            [...conversations.values()]
              .filter((conversation) => {
                const threadSeats = seats.filter(
                  (candidate) => candidate.conversationId === conversation.id,
                );
                const isSeated = (userId: string) =>
                  threadSeats.some((candidate) => candidate.userId === userId);
                return (
                  conversation.kind !== ConversationKind.Group &&
                  !conversation.isOfficial &&
                  isSeated(parameters.blockerId!) &&
                  isSeated(parameters.blockedId!) &&
                  threadSeats.some(
                    (candidate) =>
                      identityKinds.get(candidate.identityId) !==
                      IdentityKind.Profile,
                  )
                );
              })
              .map((conversation) => ({ conversationId: conversation.id })),
          ),
      };
      // Task 14: the same stand-in answers `identityBlockEvictions`, which
      // binds `blockedIdentityId`.
      const sharedMailboxThreads = builder.getRawMany;
      builder.getRawMany = () =>
        parameters.blockedIdentityId
          ? Promise.resolve(identityBlockedThreadIds(parameters))
          : sharedMailboxThreads();
      return builder;
    };

    const conversationParticipants = {
      createQueryBuilder: jest.fn(sharedMailboxThreadQuery),
      find: jest.fn(
        ({
          where,
        }: {
          where: { conversationId?: unknown; userId?: unknown };
        }) => {
          const conversationIds = whereValue(where.conversationId);
          const userIds = whereValue(where.userId);
          return Promise.resolve(
            seats.filter(
              (candidate) =>
                (!conversationIds ||
                  conversationIds.includes(candidate.conversationId)) &&
                (!userIds || userIds.includes(candidate.userId)),
            ),
          );
        },
      ),
      manager: {
        findOne: jest.fn(
          (entity: unknown, { where }: { where: { id: string } }) => {
            if (entity === Conversation) {
              return Promise.resolve(conversations.get(where.id) ?? null);
            }
            if (entity === Message) {
              return Promise.resolve(messageRows.get(where.id) ?? null);
            }
            return Promise.resolve(null);
          },
        ),
        find: jest.fn(
          (
            entity: unknown,
            { where }: { where: { id?: unknown; messageId?: string } },
          ) => {
            if (entity === Conversation) {
              const ids = whereValue(where.id) ?? [];
              return Promise.resolve(
                [...conversations.values()].filter((conversation) =>
                  ids.includes(conversation.id),
                ),
              );
            }
            if (entity === MessageReaction) {
              return Promise.resolve(
                reactionRows.filter((row) => row.messageId === where.messageId),
              );
            }
            return Promise.resolve([]);
          },
        ),
      },
    };
    conversationParticipantsFind = conversationParticipants.find;
    const isBlockedEitherWay = (first: string, second: string) =>
      blockedPairs.some(
        ([blocker, blocked]) =>
          (blocker === first && blocked === second) ||
          (blocker === second && blocked === first),
      );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        {
          provide: MessagingCoreService,
          useValue: {
            toMessageResponses,
            loadMailboxStaffFlooredUserIds,
            // Final review I2: the gateway renders through
            // `renderMessageForViewerClasses`. This stand-in renders each
            // viewer through the `toMessageResponses` stand-in, the result
            // `viewer-render-classes.spec.ts` proves the real method gives.
            renderMessageForViewerClasses: async (
              message: unknown,
              viewerIds: string[],
              conversationKind: ConversationKind,
              onRenderError: (error: unknown) => void,
            ) => {
              const rendered = await Promise.all(
                viewerIds.map(async (viewerId) => {
                  try {
                    const [response] = (await toMessageResponses(
                      [message],
                      viewerId,
                      false,
                      conversationKind,
                    )) as MessageResponse[];
                    return response ? ([[viewerId, response]] as const) : [];
                  } catch (error) {
                    onRenderError(error);
                    return [];
                  }
                }),
              );
              return new Map(rendered.flat());
            },
          },
        },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('secret') },
        },
        { provide: MessagingService, useValue: messaging },
        {
          provide: ConnectionsService,
          useValue: {
            allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: IdentitiesService,
          useValue: (() => {
            identitiesGetById = jest.fn((identityId: string) =>
              Promise.resolve(
                identityKinds.has(identityId)
                  ? { id: identityId, kind: identityKinds.get(identityId) }
                  : null,
              ),
            );
            return {
              getById: identitiesGetById,
              getByIds: jest.fn((identityIds: string[]) =>
                Promise.resolve(
                  identityIds
                    .filter((identityId) => identityKinds.has(identityId))
                    .map((identityId) => ({
                      id: identityId,
                      kind: identityKinds.get(identityId),
                    })),
                ),
              ),
              describeIdentities: jest.fn().mockResolvedValue(
                new Map([
                  [
                    MAILBOX_IDENTITY_ID,
                    {
                      displayName: 'Cafe Lisboa',
                      handle: 'cafe-lisboa',
                      avatarUrl: BUSINESS_SENDER.avatarUrl,
                    },
                  ],
                ]),
              ),
              staffUserIds: jest
                .fn()
                .mockResolvedValue(STAFF.map((member) => member.userId)),
              isRemovedPersona: jest.fn(
                (identity: { id: string; kind: IdentityKind }) =>
                  Promise.resolve(
                    identity.kind === IdentityKind.Subprofile &&
                      removedPersonaIdentityIds.has(identity.id),
                  ),
              ),
            };
          })(),
        },
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
                    isBlockedEitherWay(actorId, candidateId),
                  ),
                ),
              ),
            ),
            identityBlocksAmong: jest.fn(
              (blockerUserIds: string[], blockedIdentityIds: string[]) =>
                Promise.resolve(
                  identityBlockPairs
                    .filter(
                      ([blockerUserId, identityId]) =>
                        blockerUserIds.includes(blockerUserId) &&
                        blockedIdentityIds.includes(identityId),
                    )
                    .map(([blockerUserId, identityId]) => ({
                      blockerUserId,
                      identityId,
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
    // @ts-expect-error assigning the in-memory namespace for the test.
    gateway.namespace = namespace;
  });

  /** Everyone with the mailbox thread open, one socket each. */
  function openThreadForEveryone(): void {
    namespace.connect(CUSTOMER_USER_ID, [CONVERSATION_ID]);
    for (const member of STAFF) {
      namespace.connect(member.userId, [CONVERSATION_ID]);
    }
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  async function createMessage(senderId: string, body: string): Promise<void> {
    const message = { id: 'm1', senderId, body };
    messageRows.set(message.id, message);
    await gateway.handleMessageCreated({
      conversationId: CONVERSATION_ID,
      message: {
        ...message,
        conversationId: CONVERSATION_ID,
        senderIdentityId: STAFF.some((member) => member.userId === senderId)
          ? MAILBOX_IDENTITY_ID
          : CUSTOMER_IDENTITY_ID,
      } as never,
      response: renderForViewer(message, senderId),
    });
    await flush();
  }

  describe('message:new and conversation:message', () => {
    it('shows the customer the business, and never the staff member who replied', async () => {
      openThreadForEveryone();

      await createMessage(TIAGO.userId, 'We open at nine');

      const customerFrames = namespace.receivedBy(CUSTOMER_USER_ID);
      expect(customerFrames.map(([event]) => event).sort()).toEqual([
        'conversation:message',
        'message:new',
      ]);
      expect(staffStringsIn(customerFrames)).toEqual([]);
      const [customerMessage] = namespace.framesOf(
        CUSTOMER_USER_ID,
        'message:new',
      ) as Array<{ message: MessageResponse }>;
      expect(customerMessage!.message).toEqual(
        renderForViewer(
          { id: 'm1', senderId: TIAGO.userId, body: 'We open at nine' },
          CUSTOMER_USER_ID,
        ),
      );
    });

    it('renders each viewer through the REST renderer, with that viewer as the reader', async () => {
      openThreadForEveryone();

      await createMessage(TIAGO.userId, 'We open at nine');

      const renderCalls = toMessageResponses.mock.calls as Array<
        [unknown, string, boolean, ConversationKind]
      >;
      const renderedViewers = renderCalls.map(([, viewerId, hasLeft, kind]) => [
        viewerId,
        hasLeft,
        kind,
      ]);
      expect(renderedViewers).toEqual(
        expect.arrayContaining([
          [CUSTOMER_USER_ID, false, ConversationKind.Direct],
          [ANA.userId, false, ConversationKind.Direct],
          [RUI.userId, false, ConversationKind.Direct],
        ]),
      );
      const [anaMessage] = namespace.framesOf(
        ANA.userId,
        'message:new',
      ) as Array<{
        message: MessageResponse;
      }>;
      expect(anaMessage!.message.sender.staffFirstName).toBe('Tiago');
      const [tiagoOwnEcho] = namespace.framesOf(
        TIAGO.userId,
        'message:new',
      ) as Array<{ message: { canEdit: boolean } }>;
      expect(tiagoOwnEcho!.message.canEdit).toBe(true);
    });

    it('reaches the customer through conversation:message when they have another thread open', async () => {
      namespace.connect(CUSTOMER_USER_ID, []);
      namespace.connect(ANA.userId, [CONVERSATION_ID]);

      await createMessage(TIAGO.userId, 'Your table is ready');

      expect(namespace.framesOf(CUSTOMER_USER_ID, 'message:new')).toEqual([]);
      const frames = namespace.framesOf(
        CUSTOMER_USER_ID,
        'conversation:message',
      );
      expect(frames).toHaveLength(1);
      expect(staffStringsIn(frames)).toEqual([]);
    });

    it('delivers nothing to a staff member the customer blocked when the customer sends, and still reaches a colleague', async () => {
      blockedPairs = [[CUSTOMER_USER_ID, RUI.userId]];
      // Rui's socket was already in the room when the block was placed.
      openThreadForEveryone();

      await createMessage(CUSTOMER_USER_ID, 'Please do not reply, Rui');

      expect(namespace.receivedBy(RUI.userId)).toEqual([]);
      expect(namespace.framesOf(ANA.userId, 'message:new')).toHaveLength(1);
      expect(
        namespace.framesOf(ANA.userId, 'conversation:message'),
      ).toHaveLength(1);
    });

    it('delivers nothing to a staff member who blocked the customer', async () => {
      blockedPairs = [[RUI.userId, CUSTOMER_USER_ID]];
      openThreadForEveryone();

      await createMessage(CUSTOMER_USER_ID, 'Hello');

      expect(namespace.receivedBy(RUI.userId)).toEqual([]);
      expect(namespace.framesOf(TIAGO.userId, 'message:new')).toHaveLength(1);
    });

    it('fails closed on a mailbox thread that cannot be partitioned: only the sender hears their own message', async () => {
      // Two seats outside the mailbox identity: no single customer.
      seats.push(seat('stranger', 'identity-stranger'));
      identityKinds.set('identity-stranger', IdentityKind.Profile);
      openThreadForEveryone();
      namespace.connect('stranger', [CONVERSATION_ID]);

      await createMessage(TIAGO.userId, 'We open at nine');

      expect(namespace.receivedBy(CUSTOMER_USER_ID)).toEqual([]);
      expect(namespace.receivedBy('stranger')).toEqual([]);
      expect(namespace.receivedBy(ANA.userId)).toEqual([]);
      expect(namespace.framesOf(TIAGO.userId, 'message:new')).toHaveLength(1);
    });

    it('fails closed when a seat identity does not resolve', async () => {
      identityKinds.delete(MAILBOX_IDENTITY_ID);
      openThreadForEveryone();

      await createMessage(TIAGO.userId, 'We open at nine');

      expect(namespace.receivedBy(CUSTOMER_USER_ID)).toEqual([]);
      expect(namespace.receivedBy(ANA.userId)).toEqual([]);
    });

    it('keeps the one room broadcast on a personal thread', async () => {
      namespace.connect(CUSTOMER_USER_ID, [PERSONAL_CONVERSATION_ID]);
      namespace.connect(FRIEND_USER_ID, [PERSONAL_CONVERSATION_ID]);
      const response = { id: 'p1', body: 'hi' } as unknown as MessageResponse;

      await gateway.handleMessageCreated({
        conversationId: PERSONAL_CONVERSATION_ID,
        message: { id: 'p1', senderId: FRIEND_USER_ID } as never,
        response,
      });
      await flush();

      expect(namespace.framesOf(CUSTOMER_USER_ID, 'message:new')).toEqual([
        { conversationId: PERSONAL_CONVERSATION_ID, message: response },
      ]);
      expect(toMessageResponses).not.toHaveBeenCalled();
    });
  });

  describe('message:updated', () => {
    it('shows the customer the edit as the business', async () => {
      openThreadForEveryone();
      const edited = {
        id: 'm1',
        senderId: TIAGO.userId,
        body: 'We open at ten',
      };
      messageRows.set(edited.id, edited);

      await gateway.handleMessageUpdated({
        conversationId: CONVERSATION_ID,
        message: renderForViewer(edited, TIAGO.userId),
      });

      const frames = namespace.framesOf(CUSTOMER_USER_ID, 'message:updated');
      expect(frames).toHaveLength(1);
      expect(staffStringsIn(frames)).toEqual([]);
      expect(
        (
          namespace.framesOf(ANA.userId, 'message:updated')[0] as {
            message: MessageResponse;
          }
        ).message.sender.staffFirstName,
      ).toBe('Tiago');
    });
  });

  describe('read and message:delivered', () => {
    it("shows the customer a staff member's read as the business's, and tells no colleague", async () => {
      openThreadForEveryone();
      const lastReadAt = new Date('2026-09-22T10:00:00.000Z');

      await gateway.handleMessageRead({
        conversationId: CONVERSATION_ID,
        userId: ANA.userId,
        lastReadAt,
      });

      const customerFrames = namespace.framesOf(CUSTOMER_USER_ID, 'read');
      expect(customerFrames).toEqual([
        {
          conversationId: CONVERSATION_ID,
          identityId: MAILBOX_IDENTITY_ID,
          lastReadAt,
        },
      ]);
      expect(staffStringsIn(customerFrames)).toEqual([]);
      expect(namespace.framesOf(TIAGO.userId, 'read')).toEqual([]);
      expect(namespace.framesOf(RUI.userId, 'read')).toEqual([]);
    });

    it("relays the customer's read to every staff member except one the customer blocked", async () => {
      blockedPairs = [[CUSTOMER_USER_ID, RUI.userId]];
      openThreadForEveryone();

      await gateway.handleMessageRead({
        conversationId: CONVERSATION_ID,
        userId: CUSTOMER_USER_ID,
        lastReadAt: new Date('2026-09-22T10:00:00.000Z'),
      });

      expect(namespace.framesOf(RUI.userId, 'read')).toEqual([]);
      expect(namespace.framesOf(ANA.userId, 'read')).toHaveLength(1);
    });

    it("shows the customer a staff member's delivered tick as the business's", async () => {
      openThreadForEveryone();
      const deliveredAt = new Date('2026-09-22T10:00:00.000Z');

      await gateway.handleMessageDelivered({
        conversationId: CONVERSATION_ID,
        userId: TIAGO.userId,
        deliveredAt,
      });

      const customerFrames = namespace.framesOf(
        CUSTOMER_USER_ID,
        'message:delivered',
      );
      expect(customerFrames).toEqual([
        {
          conversationId: CONVERSATION_ID,
          identityId: MAILBOX_IDENTITY_ID,
          deliveredAt,
        },
      ]);
      expect(namespace.framesOf(ANA.userId, 'message:delivered')).toEqual([]);
    });

    it('relays no receipt from a mailbox thread that cannot be partitioned', async () => {
      identityKinds.delete(MAILBOX_IDENTITY_ID);
      openThreadForEveryone();

      await gateway.handleMessageRead({
        conversationId: CONVERSATION_ID,
        userId: ANA.userId,
        lastReadAt: new Date(),
      });
      await gateway.handleMessageDelivered({
        conversationId: CONVERSATION_ID,
        userId: ANA.userId,
        deliveredAt: new Date(),
      });

      expect(namespace.receivedBy(CUSTOMER_USER_ID)).toEqual([]);
    });
  });

  describe('reaction', () => {
    it('counts the business once for the customer, and shows staff each colleague', async () => {
      openThreadForEveryone();
      reactionRows = [
        { messageId: 'm1', userId: TIAGO.userId, key: MessageReactionKey.Love },
        { messageId: 'm1', userId: ANA.userId, key: MessageReactionKey.Love },
        {
          messageId: 'm1',
          userId: CUSTOMER_USER_ID,
          key: MessageReactionKey.Love,
        },
      ];
      const reactions = Object.values(MessageReactionKey).map((key) => ({
        key,
        count: key === MessageReactionKey.Love ? 3 : 0,
      }));

      await gateway.handleMessageReaction({
        conversationId: CONVERSATION_ID,
        messageId: 'm1',
        userId: ANA.userId,
        reactions,
      });

      const customerFrames = namespace.framesOf(
        CUSTOMER_USER_ID,
        'reaction',
      ) as Array<{
        identityId: string;
        reactions: Array<{ key: MessageReactionKey; count: number }>;
      }>;
      expect(customerFrames).toHaveLength(1);
      expect(staffStringsIn(customerFrames)).toEqual([]);
      expect(customerFrames[0]!.identityId).toBe(MAILBOX_IDENTITY_ID);
      expect(
        customerFrames[0]!.reactions.find(
          (reaction) => reaction.key === MessageReactionKey.Love,
        )!.count,
      ).toBe(2);
      expect(namespace.framesOf(TIAGO.userId, 'reaction')).toEqual([
        {
          conversationId: CONVERSATION_ID,
          messageId: 'm1',
          userId: ANA.userId,
          reactions,
        },
      ]);
    });
  });

  describe('typing', () => {
    function typingSocket(member: StaffMember): FakeSocket {
      return namespace.connect(member.userId, [CONVERSATION_ID]);
    }

    it('keeps the business typing while any staff member still types', async () => {
      namespace.connect(CUSTOMER_USER_ID, [CONVERSATION_ID]);
      const tiagoSocket = typingSocket(TIAGO);
      const anaSocket = typingSocket(ANA);
      const type = (socket: FakeSocket, isTyping: boolean) =>
        gateway.handleTyping(socket as never, {
          conversationId: CONVERSATION_ID,
          isTyping,
        });

      await type(tiagoSocket, true);
      await type(anaSocket, true);
      await type(tiagoSocket, false);

      const whileAnaTypes = (
        namespace.framesOf(CUSTOMER_USER_ID, 'typing') as Array<{
          isTyping: boolean;
        }>
      ).map((frame) => frame.isTyping);
      expect(whileAnaTypes).toEqual([true]);

      await type(anaSocket, false);

      const frames = namespace.framesOf(CUSTOMER_USER_ID, 'typing') as Array<{
        isTyping: boolean;
      }>;
      expect(frames.map((frame) => frame.isTyping)).toEqual([true, false]);
      expect(staffStringsIn(frames)).toEqual([]);
    });

    it('shows the customer no typing from the staff of a persona that moderation removed', async () => {
      identityKinds.set(MAILBOX_IDENTITY_ID, IdentityKind.Subprofile);
      namespace.connect(CUSTOMER_USER_ID, [CONVERSATION_ID]);
      const tiagoSocket = typingSocket(TIAGO);
      const type = (isTyping: boolean) =>
        gateway.handleTyping(tiagoSocket as never, {
          conversationId: CONVERSATION_ID,
          isTyping,
        });

      // A persona in good standing types to its customer as the identity.
      await type(true);
      await type(false);
      expect(namespace.framesOf(CUSTOMER_USER_ID, 'typing')).toHaveLength(2);

      removedPersonaIdentityIds.add(MAILBOX_IDENTITY_ID);
      await type(true);

      expect(namespace.framesOf(CUSTOMER_USER_ID, 'typing')).toHaveLength(2);
      for (const member of STAFF) {
        expect(namespace.framesOf(member.userId, 'typing')).toEqual([]);
      }
    });

    // CW-09: `excludedUserRooms` and `resolveTypingSenderIdentity` used to
    // each query `conversationParticipants` for this conversation on every
    // typing frame. One shared query now serves both, so a business seat's
    // frame queries this conversation's participants twice per frame: once
    // for that shared seat load, once inside `loadLiveThreadAudience` (a
    // separate helper this item leaves alone).
    it('shares one participants query between excludedUserRooms and resolveTypingSenderIdentity', async () => {
      namespace.connect(CUSTOMER_USER_ID, [CONVERSATION_ID]);
      const tiagoSocket = typingSocket(TIAGO);
      conversationParticipantsFind.mockClear();

      await gateway.handleTyping(tiagoSocket as never, {
        conversationId: CONVERSATION_ID,
        isTyping: true,
      });

      const callsForThisConversation = (
        conversationParticipantsFind.mock.calls as Array<
          [{ where: { conversationId?: unknown } }]
        >
      ).filter(([{ where }]) => where.conversationId === CONVERSATION_ID);
      expect(callsForThisConversation).toHaveLength(2);
    });

    // CW-12: the typing timestamp must be stamped ahead of the mailbox
    // lookups `handleTyping` awaits for a business seat, so DB latency on
    // those lookups cannot narrow the gap `MailboxTypingAggregator`'s TTL
    // measures a lone typist's refresh against. `identitiesGetById` stands
    // in for that latency here: it advances the clock before resolving,
    // and the timestamp `record` receives is asserted against the clock's
    // earlier value, captured ahead of that advance.
    it('records the typing timestamp ahead of the mailbox lookups it awaits', async () => {
      namespace.connect(CUSTOMER_USER_ID, [CONVERSATION_ID]);
      const tiagoSocket = typingSocket(TIAGO);
      const recordSpy = jest.spyOn(MailboxTypingAggregator.prototype, 'record');

      let clock = 1_000_000;
      const dateNowSpy = jest
        .spyOn(Date, 'now')
        .mockImplementation(() => clock);
      const resolveIdentity = identitiesGetById.getMockImplementation();
      identitiesGetById.mockImplementationOnce(
        (identityId: string): unknown => {
          // Simulates the DB latency `resolveTypingSenderIdentity` awaits,
          // landing between the timestamp capture and `record`'s own call.
          clock += 5_000;
          return resolveIdentity ? resolveIdentity(identityId) : undefined;
        },
      );

      await gateway.handleTyping(tiagoSocket as never, {
        conversationId: CONVERSATION_ID,
        isTyping: true,
      });

      expect(recordSpy).toHaveBeenCalled();
      const call = recordSpy.mock.calls[0];
      expect(call).toBeDefined();
      const [, , , , recordedAt] = call!;
      expect(recordedAt).toBe(1_000_000);

      dateNowSpy.mockRestore();
    });
  });

  describe('MEMBER_BLOCKED eviction', () => {
    it('evicts only the blocked staff member when the customer blocks them', async () => {
      openThreadForEveryone();
      blockedPairs = [[CUSTOMER_USER_ID, RUI.userId]];

      await gateway.handleMemberBlocked({
        blockerId: CUSTOMER_USER_ID,
        blockedId: RUI.userId,
      });

      const inRoom = (userId: string) =>
        namespace.sockets
          .filter((socket) => socket.data.userId === userId)
          .every((socket) => socket.rooms.has(CONVERSATION_ID));
      expect(inRoom(RUI.userId)).toBe(false);
      expect(inRoom(CUSTOMER_USER_ID)).toBe(true);
      expect(inRoom(ANA.userId)).toBe(true);
      expect(inRoom(TIAGO.userId)).toBe(true);
    });

    it('evicts only the staff member when the staff member blocks the customer', async () => {
      openThreadForEveryone();

      await gateway.handleMemberBlocked({
        blockerId: RUI.userId,
        blockedId: CUSTOMER_USER_ID,
      });

      const ruiSocket = namespace.sockets.find(
        (socket) => socket.data.userId === RUI.userId,
      )!;
      const customerSocket = namespace.sockets.find(
        (socket) => socket.data.userId === CUSTOMER_USER_ID,
      )!;
      expect(ruiSocket.rooms.has(CONVERSATION_ID)).toBe(false);
      expect(customerSocket.rooms.has(CONVERSATION_ID)).toBe(true);
    });

    it('evicts nobody from the mailbox thread for a block between two colleagues', async () => {
      openThreadForEveryone();

      await gateway.handleMemberBlocked({
        blockerId: ANA.userId,
        blockedId: TIAGO.userId,
      });

      expect(
        namespace.sockets.every((socket) => socket.rooms.has(CONVERSATION_ID)),
      ).toBe(true);
    });

    it('refuses the evicted staff member a later live join', async () => {
      messaging.canJoinConversationLive.mockImplementation(
        (_conversationId: string, userId: string) =>
          Promise.resolve(userId !== RUI.userId),
      );
      const ruiSocket = namespace.connect(RUI.userId, []);
      const client = Object.assign(ruiSocket, {
        join: jest.fn(),
      });

      const ack = await gateway.handleJoin(client as never, {
        conversationId: CONVERSATION_ID,
      });

      expect(ack).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(client.join).not.toHaveBeenCalled();
    });
  });

  describe('reaction counts agree between REST and the live frame', () => {
    it('gives the customer the same count for two staff reactions on a REST read as on the live frame', async () => {
      openThreadForEveryone();
      reactionRows = [
        { messageId: 'm1', userId: TIAGO.userId, key: MessageReactionKey.Love },
        { messageId: 'm1', userId: ANA.userId, key: MessageReactionKey.Love },
      ];
      const empty = {} as Record<string, never>;
      const identityKindsList = () =>
        [...identityKinds].map(([id, kind]) => ({ id, kind }));
      const core = new MessagingCoreService(
        {
          find: jest.fn().mockResolvedValue([
            {
              id: CONVERSATION_ID,
              kind: ConversationKind.Direct,
              isOfficial: false,
            },
          ]),
        } as unknown as Repository<Conversation>,
        {
          find: jest.fn(() =>
            Promise.resolve(
              seats.filter(
                (candidate) => candidate.conversationId === CONVERSATION_ID,
              ),
            ),
          ),
        } as unknown as Repository<ConversationParticipant>,
        {
          find: jest
            .fn()
            .mockResolvedValue([{ id: 'm1', conversationId: CONVERSATION_ID }]),
        } as unknown as Repository<Message>,
        {
          find: jest.fn(() => Promise.resolve(reactionRows)),
        } as unknown as Repository<MessageReaction>,
        empty as never,
        empty as never,
        empty as never,
        empty as never,
        empty as never,
        empty as never,
        empty as unknown as DataSource,
        empty as unknown as EventEmitter2,
        empty as unknown as UsersService,
        {
          getByIds: jest.fn(() => Promise.resolve(identityKindsList())),
        } as unknown as IdentitiesService,
        empty as unknown as IdentityAttributionService,
      );

      const restLove = (
        await core.reactionSummariesByMessage(['m1'], CUSTOMER_USER_ID)
      )
        .get('m1')!
        .find((summary) => summary.key === MessageReactionKey.Love)!;
      await gateway.handleMessageReaction({
        conversationId: CONVERSATION_ID,
        messageId: 'm1',
        userId: ANA.userId,
        reactions: Object.values(MessageReactionKey).map((key) => ({
          key,
          count: key === MessageReactionKey.Love ? 2 : 0,
        })),
      });
      const [liveFrame] = namespace.framesOf(
        CUSTOMER_USER_ID,
        'reaction',
      ) as Array<{
        reactions: Array<{ key: MessageReactionKey; count: number }>;
      }>;
      const liveLove = liveFrame!.reactions.find(
        (reaction) => reaction.key === MessageReactionKey.Love,
      )!;

      expect(restLove.count).toBe(liveLove.count);
      expect(restLove.count).toBe(1);
      expect(restLove.mine).toBe(false);
    });
  });

  describe('frames that are the same for every viewer', () => {
    it('keeps deletes, pins and the customer typing from a blocked staff member still in the room', async () => {
      blockedPairs = [[CUSTOMER_USER_ID, RUI.userId]];
      openThreadForEveryone();
      const customerSocket = namespace.sockets.find(
        (socket) => socket.data.userId === CUSTOMER_USER_ID,
      )!;

      await gateway.handleMessageDeleted({
        conversationId: CONVERSATION_ID,
        messageId: 'm1',
      });
      await gateway.handleMessagePinned({
        conversationId: CONVERSATION_ID,
        messageId: 'm2',
        pinned: true,
      });
      await gateway.handleTyping(customerSocket as never, {
        conversationId: CONVERSATION_ID,
        isTyping: true,
      });

      expect(namespace.receivedBy(RUI.userId)).toEqual([]);
      expect(namespace.receivedBy(ANA.userId).map(([event]) => event)).toEqual([
        'message:deleted',
        'message:pinned',
        'typing',
      ]);
      expect(
        namespace.framesOf(CUSTOMER_USER_ID, 'message:deleted'),
      ).toHaveLength(1);
    });

    it('keeps a departed staff member still in the room out of every frame', async () => {
      seats = seats.map((candidate) =>
        candidate.userId === RUI.userId &&
        candidate.conversationId === CONVERSATION_ID
          ? { ...candidate, leftAt: new Date() }
          : candidate,
      );
      openThreadForEveryone();

      await createMessage(CUSTOMER_USER_ID, 'Hello');
      await gateway.handleMessageDeleted({
        conversationId: CONVERSATION_ID,
        messageId: 'm1',
      });

      expect(namespace.receivedBy(RUI.userId)).toEqual([]);
      expect(namespace.framesOf(ANA.userId, 'message:deleted')).toHaveLength(1);
    });
  });

  describe('frame order within a conversation', () => {
    async function sendThenDeleteAtOnce(
      conversationId: string,
      senderId: string,
    ): Promise<void> {
      const message = { id: 'm-quick', senderId, body: 'oops' };
      messageRows.set(message.id, message);
      const created = gateway.handleMessageCreated({
        conversationId,
        message: { ...message, conversationId } as never,
        response: {
          ...renderForViewer(message, senderId),
          conversationId,
        },
      });
      const deleted = gateway.handleMessageDeleted({
        conversationId,
        messageId: message.id,
      });
      await Promise.all([created, deleted]);
      await flush();
    }

    function eventsAfterDelete(userId: string): string[] {
      const events = namespace.receivedBy(userId).map(([event]) => event);
      return events.slice(events.indexOf('message:deleted') + 1);
    }

    it('never lets a delete overtake the message:new on a personal thread', async () => {
      namespace.connect(CUSTOMER_USER_ID, [PERSONAL_CONVERSATION_ID]);
      namespace.connect(FRIEND_USER_ID, [PERSONAL_CONVERSATION_ID]);

      await sendThenDeleteAtOnce(PERSONAL_CONVERSATION_ID, FRIEND_USER_ID);

      const events = namespace
        .receivedBy(CUSTOMER_USER_ID)
        .map(([event]) => event);
      expect(events).toContain('message:deleted');
      expect(events.indexOf('message:new')).toBeLessThan(
        events.indexOf('message:deleted'),
      );
      expect(eventsAfterDelete(CUSTOMER_USER_ID)).not.toContain('message:new');
      expect(eventsAfterDelete(CUSTOMER_USER_ID)).not.toContain(
        'conversation:message',
      );
    });

    it('never lets a delete overtake the message:new on a mailbox thread', async () => {
      openThreadForEveryone();

      await sendThenDeleteAtOnce(CONVERSATION_ID, TIAGO.userId);

      for (const userId of [CUSTOMER_USER_ID, ANA.userId]) {
        const events = namespace.receivedBy(userId).map(([event]) => event);
        expect(events).toContain('message:deleted');
        expect(eventsAfterDelete(userId)).not.toContain('message:new');
        expect(eventsAfterDelete(userId)).not.toContain('conversation:message');
      }
    });
  });

  describe('typing frame stream', () => {
    it('sends the customer the same typing frames for two staff typing as for one', async () => {
      namespace.connect(CUSTOMER_USER_ID, [CONVERSATION_ID]);
      const tiagoSocket = namespace.connect(TIAGO.userId, [CONVERSATION_ID]);
      const anaSocket = namespace.connect(ANA.userId, [CONVERSATION_ID]);
      let nowMs = 1_000_000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const typeAt = async (
        atMs: number,
        socket: FakeSocket,
        isTyping: boolean,
      ) => {
        nowMs = atMs;
        await gateway.handleTyping(socket as never, {
          conversationId: CONVERSATION_ID,
          isTyping,
        });
      };
      const customerTypingStream = () =>
        (
          namespace.framesOf(CUSTOMER_USER_ID, 'typing') as Array<{
            isTyping: boolean;
          }>
        ).map((frame) => frame.isTyping);

      // One typist, refreshing every two seconds as the composer does.
      await typeAt(1_000_000, tiagoSocket, true);
      await typeAt(1_002_000, tiagoSocket, true);
      await typeAt(1_004_000, tiagoSocket, true);
      await typeAt(1_004_500, tiagoSocket, false);
      const oneTypistStream = customerTypingStream();
      for (const socket of namespace.sockets) {
        socket.emit.mockClear();
      }

      // Two typists, each refreshing every two seconds, half a second apart.
      await typeAt(1_010_000, tiagoSocket, true);
      await typeAt(1_010_500, anaSocket, true);
      await typeAt(1_012_000, tiagoSocket, true);
      await typeAt(1_012_500, anaSocket, true);
      await typeAt(1_014_000, tiagoSocket, true);
      await typeAt(1_014_400, anaSocket, false);
      await typeAt(1_014_500, tiagoSocket, false);
      const twoTypistStream = customerTypingStream();
      clock.mockRestore();

      expect(oneTypistStream).toEqual([true, true, true, false]);
      expect(twoTypistStream).toEqual(oneTypistStream);
    });
  });
  describe('Task 14: a customer who blocked the business', () => {
    function seatInOtherBusinessThread(): void {
      seats.push(
        seat(CUSTOMER_USER_ID, CUSTOMER_IDENTITY_ID, {
          conversationId: OTHER_BUSINESS_CONVERSATION_ID,
        }),
        seat(TIAGO.userId, OTHER_MAILBOX_IDENTITY_ID, {
          conversationId: OTHER_BUSINESS_CONVERSATION_ID,
        }),
      );
    }

    const roomsOf = (userId: string): string[][] =>
      namespace.sockets
        .filter((socket) => socket.data.userId === userId)
        .map((socket) => [...socket.rooms].sort());

    it('evicts the customer and every staff socket from the blocked thread, and nobody else from any room', async () => {
      seatInOtherBusinessThread();
      namespace.connect(CUSTOMER_USER_ID, [
        CONVERSATION_ID,
        PERSONAL_CONVERSATION_ID,
        OTHER_BUSINESS_CONVERSATION_ID,
      ]);
      for (const member of STAFF) {
        namespace.connect(member.userId, [CONVERSATION_ID]);
      }
      namespace.connect(TIAGO.userId, [OTHER_BUSINESS_CONVERSATION_ID]);
      namespace.connect(FRIEND_USER_ID, [PERSONAL_CONVERSATION_ID]);
      identityBlockPairs = [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]];

      await gateway.handleIdentityBlocked({
        blockerUserId: CUSTOMER_USER_ID,
        identityId: MAILBOX_IDENTITY_ID,
      });

      expect(roomsOf(CUSTOMER_USER_ID)).toEqual([
        [
          OTHER_BUSINESS_CONVERSATION_ID,
          PERSONAL_CONVERSATION_ID,
          `user:${CUSTOMER_USER_ID}`,
        ],
      ]);
      expect(roomsOf(ANA.userId)).toEqual([[`user:${ANA.userId}`]]);
      expect(roomsOf(RUI.userId)).toEqual([[`user:${RUI.userId}`]]);
      expect(roomsOf(TIAGO.userId)).toEqual([
        [`user:${TIAGO.userId}`],
        [OTHER_BUSINESS_CONVERSATION_ID, `user:${TIAGO.userId}`],
      ]);
      expect(roomsOf(FRIEND_USER_ID)).toEqual([
        [PERSONAL_CONVERSATION_ID, `user:${FRIEND_USER_ID}`],
      ]);
    });

    it('evicts nobody for a block of a business the member has no thread with', async () => {
      openThreadForEveryone();

      await gateway.handleIdentityBlocked({
        blockerUserId: CUSTOMER_USER_ID,
        identityId: OTHER_MAILBOX_IDENTITY_ID,
      });

      expect(
        namespace.sockets.every((socket) => socket.rooms.has(CONVERSATION_ID)),
      ).toBe(true);
    });

    it("delivers a customer's message on the blocked thread to nobody, from sockets still in the room", async () => {
      identityBlockPairs = [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]];
      openThreadForEveryone();

      await createMessage(CUSTOMER_USER_ID, 'Hello');

      for (const member of STAFF) {
        expect(namespace.receivedBy(member.userId)).toEqual([]);
      }
      expect(
        namespace
          .receivedBy(CUSTOMER_USER_ID)
          .filter(([event]) => event !== 'message:new'),
      ).toEqual([]);
    });

    it('delivers nothing a staff member sends on the blocked thread to the customer or to a colleague', async () => {
      identityBlockPairs = [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]];
      openThreadForEveryone();
      const customerSocket = namespace.sockets.find(
        (socket) => socket.data.userId === CUSTOMER_USER_ID,
      )!;

      await createMessage(TIAGO.userId, 'We open at nine');
      await gateway.handleMessageDeleted({
        conversationId: CONVERSATION_ID,
        messageId: 'm1',
      });
      await gateway.handleTyping(customerSocket as never, {
        conversationId: CONVERSATION_ID,
        isTyping: true,
      });

      expect(namespace.receivedBy(CUSTOMER_USER_ID)).toEqual([]);
      expect(namespace.receivedBy(ANA.userId)).toEqual([]);
      expect(namespace.receivedBy(RUI.userId)).toEqual([]);
    });

    it('relays again once the block is lifted', async () => {
      identityBlockPairs = [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]];
      openThreadForEveryone();
      await createMessage(TIAGO.userId, 'Sent while blocked');
      expect(namespace.receivedBy(CUSTOMER_USER_ID)).toEqual([]);

      identityBlockPairs = [];
      await createMessage(TIAGO.userId, 'We open at nine');

      expect(namespace.framesOf(CUSTOMER_USER_ID, 'message:new')).toHaveLength(
        1,
      );
      expect(namespace.framesOf(ANA.userId, 'message:new')).toHaveLength(1);
    });
  });
  // Task 13h: a mailbox staff seat's history floor (`history_floor_at`)
  // holds on the live frames too. Rui is a co-manager seated when the thread
  // moved into the mailbox, with his floor at the first enquiry. A "clear
  // chat" on a seat that speaks for the member themself (the customer here,
  // the friend in the personal thread) keeps the frames it always had.
  // Mailbox decisions, task 1: so does a staff member's own "clear chat",
  // which writes `cleared_at` alone.
  describe('history floor (Task 13h)', () => {
    const HISTORY_FLOOR = new Date('2026-09-10T12:00:00.000Z');
    const PRE_FLOOR = new Date('2026-09-10T11:00:00.000Z');
    const POST_FLOOR = new Date('2026-09-10T13:00:00.000Z');

    function seatOf(
      conversationId: string,
      userId: string,
    ): ConversationParticipant {
      return seats.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.userId === userId,
      )!;
    }

    /** Seating a staff member writes the floor and the clear point at one
     *  instant. */
    function placeFloor(conversationId: string, userId: string): void {
      const floored = seatOf(conversationId, userId);
      floored.clearedAt = HISTORY_FLOOR;
      floored.historyFloorAt = HISTORY_FLOOR;
    }

    /** A personal "clear chat": the clear point alone. */
    function placeClear(conversationId: string, userId: string): void {
      seatOf(conversationId, userId).clearedAt = HISTORY_FLOOR;
    }

    it("relays an edit of a message a co-manager's own clear chat covers to that co-manager", async () => {
      openThreadForEveryone();
      placeClear(CONVERSATION_ID, RUI.userId);
      const edited = {
        id: 'm-cleared-by-rui',
        senderId: TIAGO.userId,
        body: 'Edited after Rui cleared',
        createdAt: PRE_FLOOR,
      };
      messageRows.set(edited.id, edited);

      await gateway.handleMessageUpdated({
        conversationId: CONVERSATION_ID,
        message: renderForViewer(edited, TIAGO.userId),
      });

      expect(namespace.framesOf(RUI.userId, 'message:updated')).toHaveLength(1);
    });

    it("relays a reaction on a message a co-manager's own clear chat covers to that co-manager", async () => {
      openThreadForEveryone();
      placeClear(CONVERSATION_ID, RUI.userId);
      messageRows.set('m-cleared-by-rui', {
        id: 'm-cleared-by-rui',
        senderId: CUSTOMER_USER_ID,
        body: 'A message Rui cleared',
        createdAt: PRE_FLOOR,
      });

      await gateway.handleMessageReaction({
        conversationId: CONVERSATION_ID,
        messageId: 'm-cleared-by-rui',
        userId: TIAGO.userId,
        reactions: [],
      });

      expect(namespace.framesOf(RUI.userId, 'reaction')).toHaveLength(1);
    });

    it("does not relay an edit of a pre-floor message to a co-manager's socket", async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      const edited = {
        id: 'm-private',
        senderId: TIAGO.userId,
        body: 'The old private note, edited',
        createdAt: PRE_FLOOR,
      };
      messageRows.set(edited.id, edited);

      await gateway.handleMessageUpdated({
        conversationId: CONVERSATION_ID,
        message: renderForViewer(edited, TIAGO.userId),
      });

      expect(namespace.framesOf(RUI.userId, 'message:updated')).toEqual([]);
      expect(JSON.stringify(namespace.receivedBy(RUI.userId))).not.toContain(
        'The old private note',
      );
      expect(namespace.framesOf(ANA.userId, 'message:updated')).toHaveLength(1);
      expect(
        namespace.framesOf(CUSTOMER_USER_ID, 'message:updated'),
      ).toHaveLength(1);
    });

    it('relays an edit of a post-floor message to the same co-manager', async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      const edited = {
        id: 'm-after',
        senderId: TIAGO.userId,
        body: 'We open at ten',
        createdAt: POST_FLOOR,
      };
      messageRows.set(edited.id, edited);

      await gateway.handleMessageUpdated({
        conversationId: CONVERSATION_ID,
        message: renderForViewer(edited, TIAGO.userId),
      });

      expect(namespace.framesOf(RUI.userId, 'message:updated')).toHaveLength(1);
    });

    it('does not relay a reaction on a pre-floor message to the co-manager', async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      messageRows.set('m-private', {
        id: 'm-private',
        senderId: CUSTOMER_USER_ID,
        body: 'An old private message',
        createdAt: PRE_FLOOR,
      });

      await gateway.handleMessageReaction({
        conversationId: CONVERSATION_ID,
        messageId: 'm-private',
        userId: TIAGO.userId,
        reactions: [],
      });

      expect(namespace.framesOf(RUI.userId, 'reaction')).toEqual([]);
      expect(namespace.framesOf(ANA.userId, 'reaction')).toHaveLength(1);
    });

    it('does not relay a pin or an unpin of a pre-floor message to the co-manager (13h review M5)', async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      messageRows.set('m-private', {
        id: 'm-private',
        senderId: CUSTOMER_USER_ID,
        body: 'An old private message',
        createdAt: PRE_FLOOR,
      });

      for (const pinned of [true, false]) {
        await gateway.handleMessagePinned({
          conversationId: CONVERSATION_ID,
          messageId: 'm-private',
          pinned,
        });
      }

      expect(namespace.framesOf(RUI.userId, 'message:pinned')).toEqual([]);
      expect(namespace.framesOf(ANA.userId, 'message:pinned')).toHaveLength(2);
      expect(
        namespace.framesOf(CUSTOMER_USER_ID, 'message:pinned'),
      ).toHaveLength(2);
      expect(loadMailboxStaffFlooredUserIds).toHaveBeenCalledWith(
        CONVERSATION_ID,
        'm-private',
        { shouldIncludeDeletedMessage: false },
      );
    });

    it('relays a pin of a post-floor message to the same co-manager (13h review M5)', async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      messageRows.set('m-after', {
        id: 'm-after',
        senderId: CUSTOMER_USER_ID,
        body: 'A newer message',
        createdAt: POST_FLOOR,
      });

      await gateway.handleMessagePinned({
        conversationId: CONVERSATION_ID,
        messageId: 'm-after',
        pinned: true,
      });

      expect(namespace.framesOf(RUI.userId, 'message:pinned')).toHaveLength(1);
    });

    it('does not relay the delete of a pre-floor message to the co-manager, reading the soft-deleted row (13h review M5)', async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      messageRows.set('m-private', {
        id: 'm-private',
        senderId: TIAGO.userId,
        body: 'An old private message',
        createdAt: PRE_FLOOR,
      });

      await gateway.handleMessageDeleted({
        conversationId: CONVERSATION_ID,
        messageId: 'm-private',
      });

      expect(namespace.framesOf(RUI.userId, 'message:deleted')).toEqual([]);
      expect(namespace.framesOf(ANA.userId, 'message:deleted')).toHaveLength(1);
      expect(
        namespace.framesOf(CUSTOMER_USER_ID, 'message:deleted'),
      ).toHaveLength(1);
      expect(loadMailboxStaffFlooredUserIds).toHaveBeenCalledWith(
        CONVERSATION_ID,
        'm-private',
        { shouldIncludeDeletedMessage: true },
      );
    });

    it('sends a floored co-manager the message:new rendered for them when a reply quotes a pre-floor parent (13h review M7)', async () => {
      openThreadForEveryone();
      placeFloor(CONVERSATION_ID, RUI.userId);
      messageRows.set('m-parent', {
        id: 'm-parent',
        senderId: CUSTOMER_USER_ID,
        body: 'An old private message',
        createdAt: PRE_FLOOR,
      });
      const reply = {
        id: 'm-reply',
        senderId: TIAGO.userId,
        body: 'Answering that',
        createdAt: POST_FLOOR,
        replyToId: 'm-parent',
      };
      messageRows.set(reply.id, reply);
      // The renderer's own floor rule (Task 13h) gives the floored viewer an
      // unavailable quote, and every other viewer the parent's snippet.
      toMessageResponses.mockImplementation(
        (rows: Array<typeof reply>, viewerId: string) =>
          Promise.resolve(
            rows.map((row) => ({
              ...renderForViewer(row, viewerId),
              replyTo:
                viewerId === RUI.userId
                  ? { id: 'm-parent', deleted: true, snippet: '' }
                  : {
                      id: 'm-parent',
                      deleted: false,
                      snippet: 'An old private message',
                    },
            })),
          ),
      );

      await gateway.handleMessageCreated({
        conversationId: CONVERSATION_ID,
        message: {
          ...reply,
          conversationId: CONVERSATION_ID,
          senderIdentityId: MAILBOX_IDENTITY_ID,
        } as never,
        response: renderForViewer(reply, TIAGO.userId),
      });
      await flush();

      const ruiRenderCalls = (
        toMessageResponses.mock.calls as Array<
          [Array<{ id: string }>, string, boolean, ConversationKind]
        >
      ).filter(([, viewerId]) => viewerId === RUI.userId);
      expect(ruiRenderCalls).toEqual([
        [
          [expect.objectContaining({ id: 'm-reply', replyToId: 'm-parent' })],
          RUI.userId,
          false,
          ConversationKind.Direct,
        ],
      ]);
      const renderedForRui = (await toMessageResponses.mock.results.find(
        (_result, index) =>
          ruiRenderCalls[0] === toMessageResponses.mock.calls[index],
      )!.value) as MessageResponse[];
      const [ruiFrame] = namespace.framesOf(
        RUI.userId,
        'message:new',
      ) as Array<{
        message: MessageResponse;
      }>;
      expect(ruiFrame!.message).toEqual(renderedForRui[0]);
      expect(JSON.stringify(namespace.receivedBy(RUI.userId))).not.toContain(
        'An old private message',
      );
    });

    it('still relays an edit to the customer after the customer cleared the mailbox thread', async () => {
      openThreadForEveryone();
      placeClear(CONVERSATION_ID, CUSTOMER_USER_ID);
      const edited = {
        id: 'm-cleared-by-customer',
        senderId: TIAGO.userId,
        body: 'Edited after the customer cleared',
        createdAt: PRE_FLOOR,
      };
      messageRows.set(edited.id, edited);

      await gateway.handleMessageUpdated({
        conversationId: CONVERSATION_ID,
        message: renderForViewer(edited, TIAGO.userId),
      });

      expect(
        namespace.framesOf(CUSTOMER_USER_ID, 'message:updated'),
      ).toHaveLength(1);
    });

    it('still relays an edit of a cleared message to a personal-thread member who cleared the chat', async () => {
      namespace.connect(CUSTOMER_USER_ID, [PERSONAL_CONVERSATION_ID]);
      namespace.connect(FRIEND_USER_ID, [PERSONAL_CONVERSATION_ID]);
      placeClear(PERSONAL_CONVERSATION_ID, FRIEND_USER_ID);
      const edited = {
        id: 'p-cleared',
        senderId: CUSTOMER_USER_ID,
        body: 'Cleared, then edited',
        createdAt: PRE_FLOOR,
      };
      messageRows.set(edited.id, edited);
      const response = {
        id: edited.id,
        body: edited.body,
      } as unknown as MessageResponse;

      await gateway.handleMessageUpdated({
        conversationId: PERSONAL_CONVERSATION_ID,
        message: response,
      });

      expect(namespace.framesOf(FRIEND_USER_ID, 'message:updated')).toEqual([
        { conversationId: PERSONAL_CONVERSATION_ID, message: response },
      ]);
    });

    it('keeps the one room broadcast of a personal-thread reply quoting a message the friend cleared', async () => {
      namespace.connect(CUSTOMER_USER_ID, [PERSONAL_CONVERSATION_ID]);
      namespace.connect(FRIEND_USER_ID, [PERSONAL_CONVERSATION_ID]);
      placeClear(PERSONAL_CONVERSATION_ID, FRIEND_USER_ID);
      messageRows.set('p-parent', {
        id: 'p-parent',
        senderId: FRIEND_USER_ID,
        body: 'Something the friend cleared',
        createdAt: PRE_FLOOR,
      });
      const reply = {
        id: 'p-reply',
        senderId: CUSTOMER_USER_ID,
        body: 'Replying to that',
        createdAt: POST_FLOOR,
        replyToId: 'p-parent',
      };
      messageRows.set(reply.id, reply);
      const senderResponse = {
        id: reply.id,
        body: reply.body,
        replyTo: { id: 'p-parent', snippet: 'Something the friend cleared' },
      } as unknown as MessageResponse;

      await gateway.handleMessageCreated({
        conversationId: PERSONAL_CONVERSATION_ID,
        message: {
          ...reply,
          conversationId: PERSONAL_CONVERSATION_ID,
        } as never,
        response: senderResponse,
      });
      await flush();

      expect(namespace.framesOf(FRIEND_USER_ID, 'message:new')).toEqual([
        { conversationId: PERSONAL_CONVERSATION_ID, message: senderResponse },
      ]);
      expect(toMessageResponses).not.toHaveBeenCalled();
      expect(loadMailboxStaffFlooredUserIds).not.toHaveBeenCalled();
    });
  });
});
