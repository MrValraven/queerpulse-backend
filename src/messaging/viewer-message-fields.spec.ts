// The gateway imports the `cookie` package (v2), which is ESM-only and which
// ts-jest cannot load. Mocked exactly like `chat.gateway.spec.ts` does.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ChatGateway } from '../chat/chat.gateway';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Message, MessageKind } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import type { MessageResponse } from './message-response';
import { MessageLike, MessagingCoreService } from './messaging-core.service';
import { isSentByViewerField } from './viewer-message-fields';

/**
 * Task 23, part B: a staff viewer can tell their own business replies from
 * a colleague's through `isSentByViewer`. The key rides only a business
 * reply read by staff of the business that sent it. Customers and readers
 * of personal threads receive responses without it.
 *
 * Cafe Lisboa is a listing mailbox staffed by Ana and Rui; Marta is the
 * customer. Joana and Marta also share a personal thread.
 */
const CONVERSATION_ID = 'c-mailbox';
const PERSONAL_CONVERSATION_ID = 'c-personal';
const ANA = 'staff-ana';
const RUI = 'staff-rui';
const CUSTOMER = 'customer-marta';
const FRIEND = 'friend-joana';
const LISTING_IDENTITY_ID = 'identity-cafe-lisboa';
const CUSTOMER_IDENTITY_ID = 'identity-marta';
const FRIEND_IDENTITY_ID = 'identity-joana';

const IDENTITY_KINDS = new Map<string, IdentityKind>([
  [LISTING_IDENTITY_ID, IdentityKind.Listing],
  [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
  [FRIEND_IDENTITY_ID, IdentityKind.Profile],
]);

function seat(
  conversationId: string,
  userId: string,
  identityId: string,
): ConversationParticipant {
  return {
    id: `seat-${conversationId}-${userId}`,
    conversationId,
    userId,
    identityId,
    role: 'member',
    leftAt: null,
    clearedAt: null,
    deliveredAt: null,
    lastReadAt: null,
  } as unknown as ConversationParticipant;
}

const SEATS = [
  seat(CONVERSATION_ID, ANA, LISTING_IDENTITY_ID),
  seat(CONVERSATION_ID, RUI, LISTING_IDENTITY_ID),
  seat(CONVERSATION_ID, CUSTOMER, CUSTOMER_IDENTITY_ID),
  seat(PERSONAL_CONVERSATION_ID, CUSTOMER, CUSTOMER_IDENTITY_ID),
  seat(PERSONAL_CONVERSATION_ID, FRIEND, FRIEND_IDENTITY_ID),
];

function messageRow(overrides: Partial<MessageLike>): MessageLike {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    senderId: ANA,
    senderIdentityId: LISTING_IDENTITY_ID,
    body: 'We open at nine',
    replyToId: null,
    createdAt: new Date('2026-09-22T10:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.User,
    systemEvent: null,
    attachment: null,
    ...overrides,
  };
}

const ANA_REPLY = messageRow({ id: 'reply-by-ana', senderId: ANA });
const RUI_REPLY = messageRow({ id: 'reply-by-rui', senderId: RUI });

function profile(userId: string, firstName: string, lastName: string) {
  return {
    userId,
    firstName,
    lastName,
    slug: `${firstName}-${lastName}`.toLowerCase(),
    avatarUrl: null,
    photoVisible: true,
  };
}

function buildService(
  conversations: { findOne: jest.Mock } = { findOne: jest.fn() },
) {
  const conversationId = (where: { conversationId?: unknown }) =>
    where.conversationId;
  const participants = {
    find: jest.fn(({ where }: { where: { conversationId?: unknown } }) =>
      Promise.resolve(
        SEATS.filter(
          (candidate) => candidate.conversationId === conversationId(where),
        ),
      ),
    ),
  };
  const emptyFind = { find: jest.fn().mockResolvedValue([]) };
  const profiles = {
    find: jest
      .fn()
      .mockResolvedValue([
        profile(ANA, 'Ana', 'Sousa'),
        profile(RUI, 'Rui', 'Lopes'),
        profile(CUSTOMER, 'Marta', 'Silva'),
        profile(FRIEND, 'Joana', 'Reis'),
      ]),
  };
  const usersService = {
    findById: jest
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve({ id, role: UserRole.Member }),
      ),
  };
  const identities = {
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        identityIds
          .filter((identityId) => IDENTITY_KINDS.has(identityId))
          .map((identityId) => ({
            id: identityId,
            kind: IDENTITY_KINDS.get(identityId),
          })),
      ),
    ),
    describeIdentities: jest.fn().mockResolvedValue(
      new Map([
        [
          LISTING_IDENTITY_ID,
          {
            displayName: 'Cafe Lisboa',
            handle: 'cafe-lisboa',
            avatarUrl: null,
          },
        ],
      ]),
    ),
    // Final review I2: the live render groups readers by the identities
    // they staff. The resolver below names nobody for any reader, so no
    // reader staffs anything here.
    staffUserIds: jest.fn().mockResolvedValue([]),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
    // Final review I2: the live render reads the resolver's rows once
    // per message and builds each reader's resolver from them.
    loadStaffNameResolverInputs: jest.fn().mockResolvedValue({}),
  };
  const empty = {} as Record<string, never>;
  return new MessagingCoreService(
    conversations as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    emptyFind as unknown as Repository<Message>,
    emptyFind as unknown as Repository<MessageReaction>,
    emptyFind as unknown as Repository<ConversationPinnedMessage>,
    emptyFind as unknown as Repository<MessageStar>,
    emptyFind as unknown as Repository<MessageHide>,
    emptyFind as unknown as Repository<ContentModeration>,
    profiles as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    // Final review I2: the live render reads every viewer's role in one
    // batch; no one here is platform staff, as `findById` below says.
    {
      getRepository: () => ({ find: () => Promise.resolve([]) }),
    } as unknown as DataSource,
    empty as unknown as EventEmitter2,
    usersService as unknown as UsersService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
}

async function readAs(
  service: MessagingCoreService,
  rows: MessageLike[],
  viewerId: string,
  conversationKind: ConversationKind = ConversationKind.Direct,
) {
  return service.toMessageResponses(rows, viewerId, false, conversationKind);
}

describe('MessagingCoreService.toMessageResponses, isSentByViewer (Task 23)', () => {
  it('tells a staff viewer their own business reply from a colleague reply', async () => {
    const service = buildService();

    const [ownReply, colleagueReply] = await readAs(
      service,
      [ANA_REPLY, RUI_REPLY],
      ANA,
    );

    expect(ownReply!.isSentByViewer).toBe(true);
    expect(colleagueReply!.isSentByViewer).toBe(false);

    const [anaReplyForRui, ruiReplyForRui] = await readAs(
      service,
      [ANA_REPLY, RUI_REPLY],
      RUI,
    );
    expect(anaReplyForRui!.isSentByViewer).toBe(false);
    expect(ruiReplyForRui!.isSentByViewer).toBe(true);
  });

  it('gives the customer no isSentByViewer key on either business reply', async () => {
    const service = buildService();

    const responses = await readAs(service, [ANA_REPLY, RUI_REPLY], CUSTOMER);

    for (const response of responses) {
      expect(Object.keys(response)).not.toContain('isSentByViewer');
      expect(JSON.stringify(response)).not.toContain('isSentByViewer');
    }
  });

  it('gives neither side of a personal thread the key', async () => {
    const service = buildService();
    const rows = [
      messageRow({
        id: 'from-marta',
        conversationId: PERSONAL_CONVERSATION_ID,
        senderId: CUSTOMER,
        senderIdentityId: CUSTOMER_IDENTITY_ID,
      }),
      messageRow({
        id: 'from-joana',
        conversationId: PERSONAL_CONVERSATION_ID,
        senderId: FRIEND,
        senderIdentityId: FRIEND_IDENTITY_ID,
      }),
    ];

    for (const viewerId of [CUSTOMER, FRIEND]) {
      const responses = await readAs(service, rows, viewerId);
      expect(JSON.stringify(responses)).not.toContain('isSentByViewer');
    }
  });

  it('leaves the key off a system row and off a row whose identity did not resolve', () => {
    const context = {
      viewerId: ANA,
      viewerSeatIdentityId: LISTING_IDENTITY_ID,
      identityKindById: new Map([[LISTING_IDENTITY_ID, IdentityKind.Listing]]),
      identityDescriptionById: new Map(),
      isGroupOrOfficialConversation: false,
    };

    expect(
      isSentByViewerField(
        { ...ANA_REPLY, kind: MessageKind.System, systemEvent: null },
        context,
      ),
    ).toEqual({});
    expect(
      isSentByViewerField(ANA_REPLY, {
        ...context,
        identityKindById: new Map(),
      }),
    ).toEqual({});
    expect(isSentByViewerField(ANA_REPLY, context)).toEqual({
      isSentByViewer: true,
    });
    expect(
      isSentByViewerField(ANA_REPLY, {
        ...context,
        isGroupOrOfficialConversation: true,
      }),
    ).toEqual({});
  });

  it('leaves the key off a group thread even when its seats speak for a business', async () => {
    const service = buildService();

    for (const viewerId of [ANA, RUI]) {
      const responses = await readAs(
        service,
        [ANA_REPLY, RUI_REPLY],
        viewerId,
        ConversationKind.Group,
      );
      expect(JSON.stringify(responses)).not.toContain('isSentByViewer');
    }
  });

  it('leaves the key off an official thread even when its seats speak for a business', async () => {
    const conversations = {
      findOne: jest.fn().mockResolvedValue({ isOfficial: true }),
    };
    const service = buildService(conversations);

    for (const viewerId of [ANA, RUI]) {
      const responses = await readAs(service, [ANA_REPLY, RUI_REPLY], viewerId);
      expect(JSON.stringify(responses)).not.toContain('isSentByViewer');
    }
    expect(conversations.findOne).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      select: { isOfficial: true },
    });
  });

  it('reads the official flag only for a viewer whose seat speaks for a business', async () => {
    const conversations = {
      findOne: jest.fn().mockResolvedValue({ isOfficial: false }),
    };
    const service = buildService(conversations);

    await readAs(service, [ANA_REPLY, RUI_REPLY], CUSTOMER);
    expect(conversations.findOne).not.toHaveBeenCalled();

    const [ownReply] = await readAs(service, [ANA_REPLY], ANA);
    expect(ownReply!.isSentByViewer).toBe(true);
    expect(conversations.findOne).toHaveBeenCalledTimes(1);
  });

  it('carries the right value for each viewer through the gateway per-viewer mailbox render', async () => {
    const service = buildService();
    // The gateway with only what `renderMessageForViewers` reads.
    const gateway = Object.assign(Object.create(ChatGateway.prototype), {
      messagingCore: service,
      logger: new Logger('ChatGateway'),
    }) as ChatGateway;
    const renderMessageForViewers = (
      gateway as unknown as {
        renderMessageForViewers: (
          message: MessageLike,
          viewerUserIds: ReadonlyArray<string>,
          actorUserId: string | null,
          actorResponse: MessageResponse,
        ) => Promise<Map<string, MessageResponse>>;
      }
    ).renderMessageForViewers.bind(gateway);
    // The sender's own render, as `buildPostResult` hands it to the event.
    const [senderResponse] = await readAs(service, [ANA_REPLY], ANA);

    const responseByUserId = await renderMessageForViewers(
      ANA_REPLY,
      [CUSTOMER, ANA, RUI],
      ANA,
      senderResponse!,
    );

    expect(
      (responseByUserId.get(ANA) as { isSentByViewer?: boolean })
        .isSentByViewer,
    ).toBe(true);
    expect(
      (responseByUserId.get(RUI) as { isSentByViewer?: boolean })
        .isSentByViewer,
    ).toBe(false);
    const customerFrame = JSON.stringify(responseByUserId.get(CUSTOMER));
    expect(customerFrame).toContain('Cafe Lisboa');
    expect(customerFrame).not.toContain('isSentByViewer');
  });
});
