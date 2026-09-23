import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message, MessageKind } from './entities/message.entity';
import { MESSAGE_SUBJECT_TYPE } from './message-visibility-predicates';
import { MessagingCoreService } from './messaging-core.service';
import { countUnreadConversationsByIdentity } from './unread-conversations-query';

/**
 * Task 24 cleanup: the mailbox-filtered inbox (`GET /conversations?as=`,
 * `ConversationsService.listConversations`) and the mailbox switcher
 * (`GET /identities/mailboxes`, whose `unreadCount` is
 * `countUnreadConversationsByIdentity`) are two separate SQL queries. The
 * rule that makes them agree is the client's own unread rule
 * (`isThreadUnread`): a row of the filtered inbox counts when it is not
 * archived AND it has an unread message or is marked unread. The switcher
 * leaves archived seats out in SQL; the inbox returns them with their
 * `archivedAt`, and the client's unread filter drops them.
 *
 * Both queries must be read by Postgres itself, so this spec runs against a
 * real database and is skipped unless
 * `MAILBOX_UNREAD_AGREEMENT_DATABASE_URL` names one. It builds the schema
 * with `synchronize` after dropping every table, so it refuses any database
 * whose name does not end in `_test`. Run it with, for example:
 *
 *   MAILBOX_UNREAD_AGREEMENT_DATABASE_URL=postgres://postgres@127.0.0.1:55447/mailbox_unread_test \
 *     npx jest src/messaging/mailbox-unread-agreement.spec.ts
 *
 * Ana staffs Cafe Lisboa (a listing) and Tiago Studio (a second listing);
 * Rui is her colleague at Cafe Lisboa. The customers write to the cafe.
 */
const DATABASE_URL = process.env.MAILBOX_UNREAD_AGREEMENT_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ANA = '10000000-0000-4000-8000-000000000001';
const RUI = '10000000-0000-4000-8000-000000000002';
const CUSTOMER_IDS = [
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000013',
  '10000000-0000-4000-8000-000000000014',
  '10000000-0000-4000-8000-000000000015',
  '10000000-0000-4000-8000-000000000016',
  '10000000-0000-4000-8000-000000000017',
  '10000000-0000-4000-8000-000000000018',
  '10000000-0000-4000-8000-000000000019',
  '10000000-0000-4000-8000-000000000020',
];
const CAFE_IDENTITY_ID = '20000000-0000-4000-8000-000000000001';
const STUDIO_IDENTITY_ID = '20000000-0000-4000-8000-000000000002';
const ANA_PROFILE_IDENTITY_ID = '20000000-0000-4000-8000-000000000003';
const RUI_PROFILE_IDENTITY_ID = '20000000-0000-4000-8000-000000000004';

const HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = new Date('2026-09-01T09:00:00.000Z').getTime();
const atHour = (hour: number) => new Date(BASE_TIME + hour * HOUR_MS);

function profileIdentityIdOf(userId: string): string {
  return `3${userId.slice(1)}`;
}

function conversationIdOf(index: number): string {
  return `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** How one fixture thread is set up for Ana's seat. */
interface ThreadCase {
  label: string;
  /** The identity Ana's own seat speaks for. */
  anaSeatIdentityId: string;
  /** Which customer (an index into `CUSTOMER_IDS`) holds the other seat. */
  customerIndex: number;
  /** Messages in order: who sent them and as which identity. */
  messages: ReadonlyArray<{
    senderId: string;
    senderIdentityId: string;
    hour: number;
    isHiddenForAna?: boolean;
    isModerated?: boolean;
    /** The `moved_to_business_mailbox` note, with Ana as the owner who
     *  moved the thread. */
    isMovedNote?: boolean;
  }>;
  anaLastReadHour: number | null;
  isArchived?: boolean;
  isMarkedUnread?: boolean;
}

const CAFE_THREADS: ReadonlyArray<ThreadCase> = [
  {
    label: 'unread customer message',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 0,
    messages: [{ senderId: 'customer', senderIdentityId: 'customer', hour: 2 }],
    anaLastReadHour: null,
  },
  {
    label: 'customer message already read',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 1,
    messages: [{ senderId: 'customer', senderIdentityId: 'customer', hour: 2 }],
    anaLastReadHour: 3,
  },
  {
    label: 'only a colleague reply sent as the business after the read',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 2,
    messages: [
      { senderId: 'customer', senderIdentityId: 'customer', hour: 1 },
      { senderId: RUI, senderIdentityId: CAFE_IDENTITY_ID, hour: 4 },
    ],
    anaLastReadHour: 2,
  },
  {
    label: 'marked unread with nothing new',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 3,
    messages: [{ senderId: 'customer', senderIdentityId: 'customer', hour: 1 }],
    anaLastReadHour: 2,
    isMarkedUnread: true,
  },
  {
    label: 'archived with an unread customer message',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 4,
    messages: [{ senderId: 'customer', senderIdentityId: 'customer', hour: 5 }],
    anaLastReadHour: null,
    isArchived: true,
  },
  {
    label: 'the only unread message is hidden for Ana',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 5,
    messages: [
      { senderId: 'customer', senderIdentityId: 'customer', hour: 1 },
      {
        senderId: 'customer',
        senderIdentityId: 'customer',
        hour: 6,
        isHiddenForAna: true,
      },
    ],
    anaLastReadHour: 2,
  },
  {
    label: 'the only unread message was taken down',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 6,
    messages: [
      { senderId: 'customer', senderIdentityId: 'customer', hour: 1 },
      {
        senderId: 'customer',
        senderIdentityId: 'customer',
        hour: 7,
        isModerated: true,
      },
    ],
    anaLastReadHour: 2,
  },
  {
    label: 'the newest row is the moved note, read',
    anaSeatIdentityId: CAFE_IDENTITY_ID,
    customerIndex: 9,
    messages: [
      { senderId: 'customer', senderIdentityId: 'customer', hour: 1 },
      {
        senderId: 'owner',
        senderIdentityId: CAFE_IDENTITY_ID,
        hour: 2,
        isMovedNote: true,
      },
    ],
    anaLastReadHour: 3,
  },
];

const OTHER_THREADS: ReadonlyArray<ThreadCase> = [
  {
    label: 'unread thread of the second mailbox',
    anaSeatIdentityId: STUDIO_IDENTITY_ID,
    customerIndex: 7,
    messages: [{ senderId: 'customer', senderIdentityId: 'customer', hour: 3 }],
    anaLastReadHour: null,
  },
  {
    label: "unread thread on Ana's own profile",
    anaSeatIdentityId: ANA_PROFILE_IDENTITY_ID,
    customerIndex: 8,
    messages: [{ senderId: 'customer', senderIdentityId: 'customer', hour: 3 }],
    anaLastReadHour: null,
  },
];

describeWithDatabase(
  'mailbox unread agreement on real Postgres (Task 24 cleanup)',
  () => {
    let dataSource: DataSource;
    let service: ConversationsService;

    beforeAll(async () => {
      const databaseName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!databaseName.endsWith('_test')) {
        throw new Error(
          `Refusing to drop and rebuild "${databaseName}": the database name must end in _test`,
        );
      }
      dataSource = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        entities: [`${__dirname}/../**/*.entity.ts`],
        namingStrategy: new SnakeNamingStrategy(),
        dropSchema: true,
        synchronize: true,
      });
      await dataSource.initialize();
      await seedFixture(dataSource);
      service = buildService(dataSource);
    }, 120000);

    afterAll(async () => {
      await dataSource?.destroy();
    });

    it('counts a mailbox thread when it is not archived and has an unread message or is marked unread: the ?as= inbox rows by that rule equal GET /identities/mailboxes unreadCount', async () => {
      for (const mailboxIdentityId of [CAFE_IDENTITY_ID, STUDIO_IDENTITY_ID]) {
        const page = await service.listConversations(ANA, {
          limit: 100,
          mailboxIdentityId,
        });
        const unreadRowCount = page.data.filter(
          (row) =>
            !row.archivedAt &&
            (row.unreadCount > 0 || Boolean(row.markedUnreadAt)),
        ).length;
        const switcherCounts = await countUnreadConversationsByIdentity(
          dataSource.getRepository(ConversationParticipant),
          ANA,
          [mailboxIdentityId],
        );

        expect(unreadRowCount).toBe(switcherCounts.get(mailboxIdentityId) ?? 0);
      }
    });

    it('pins the fixture: the cafe has two unread threads, and its archived thread is listed with its unread message and left out by the rule', async () => {
      const page = await service.listConversations(ANA, {
        limit: 100,
        mailboxIdentityId: CAFE_IDENTITY_ID,
      });
      const switcherCounts = await countUnreadConversationsByIdentity(
        dataSource.getRepository(ConversationParticipant),
        ANA,
        [CAFE_IDENTITY_ID, STUDIO_IDENTITY_ID],
      );

      expect(page.data).toHaveLength(CAFE_THREADS.length);
      expect(switcherCounts.get(CAFE_IDENTITY_ID)).toBe(2);
      expect(switcherCounts.get(STUDIO_IDENTITY_ID)).toBe(1);
      const archivedRow = page.data.find((row) => Boolean(row.archivedAt));
      expect(archivedRow?.unreadCount).toBe(1);
    });

    it('previews the moved note with the owner for staff and with the business for the customer (Task 23 cleanup)', async () => {
      const movedThreadId = conversationIdOf(
        CAFE_THREADS.findIndex((thread) =>
          thread.messages.some((message) => message.isMovedNote),
        ) + 1,
      );
      const staffPage = await service.listConversations(ANA, {
        limit: 100,
        mailboxIdentityId: CAFE_IDENTITY_ID,
      });
      const staffEvent = staffPage.data.find((row) => row.id === movedThreadId)
        ?.lastMessage?.systemEvent;
      expect(staffEvent?.actorName).toBe('Member0 Fixture');
      expect(staffEvent?.actorIsMe).toBe(true);

      const customerPage = await service.listConversations(CUSTOMER_IDS[9]!, {
        limit: 100,
      });
      const customerRow = customerPage.data.find(
        (row) => row.id === movedThreadId,
      );
      expect(customerRow?.lastMessage?.systemEvent?.actorName).toBe(
        `Identity ${CAFE_IDENTITY_ID}`,
      );
      expect(customerRow?.lastMessage?.systemEvent?.actorHandle).toBeNull();
      expect(JSON.stringify(customerRow)).not.toContain('Member0');
    });
  },
);

async function seedFixture(dataSource: DataSource): Promise<void> {
  const allUserIds = [ANA, RUI, ...CUSTOMER_IDS];
  await dataSource.getRepository(User).insert(
    allUserIds.map((userId) => ({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
    })),
  );
  await dataSource.getRepository(Profile).insert(
    allUserIds.map((userId, index) => ({
      userId,
      slug: `member-${index}`,
      firstName: `Member${index}`,
      lastName: 'Fixture',
    })),
  );
  await dataSource.getRepository(Identity).insert([
    { id: CAFE_IDENTITY_ID, kind: IdentityKind.Listing },
    { id: STUDIO_IDENTITY_ID, kind: IdentityKind.Listing },
    { id: ANA_PROFILE_IDENTITY_ID, kind: IdentityKind.Profile, userId: ANA },
    { id: RUI_PROFILE_IDENTITY_ID, kind: IdentityKind.Profile, userId: RUI },
    ...CUSTOMER_IDS.map((customerId) => ({
      id: profileIdentityIdOf(customerId),
      kind: IdentityKind.Profile,
      userId: customerId,
    })),
  ]);

  const threads = [...CAFE_THREADS, ...OTHER_THREADS];
  for (const [index, thread] of threads.entries()) {
    const conversationId = conversationIdOf(index + 1);
    const customerId = CUSTOMER_IDS[thread.customerIndex]!;
    const customerIdentityId = profileIdentityIdOf(customerId);
    await dataSource.getRepository(Conversation).insert({
      id: conversationId,
      createdAt: atHour(0),
      openedAt: atHour(0),
    });
    const seats: Array<Partial<ConversationParticipant>> = [
      {
        conversationId,
        userId: ANA,
        identityId: thread.anaSeatIdentityId,
        lastReadAt:
          thread.anaLastReadHour === null
            ? null
            : atHour(thread.anaLastReadHour),
        archivedAt: thread.isArchived ? atHour(8) : null,
        markedUnreadAt: thread.isMarkedUnread ? atHour(8) : null,
      },
      { conversationId, userId: customerId, identityId: customerIdentityId },
    ];
    if (thread.anaSeatIdentityId === CAFE_IDENTITY_ID) {
      seats.push({ conversationId, userId: RUI, identityId: CAFE_IDENTITY_ID });
    }
    await dataSource.getRepository(ConversationParticipant).insert(seats);
    for (const [messageIndex, message] of thread.messages.entries()) {
      const isFromCustomer = message.senderId === 'customer';
      const messageId = `50000000-0000-4000-8000-${String(
        index * 10 + messageIndex + 1,
      ).padStart(12, '0')}`;
      await dataSource.getRepository(Message).insert(
        message.isMovedNote
          ? {
              id: messageId,
              conversationId,
              senderId: null,
              senderIdentityId: message.senderIdentityId,
              body: 'This conversation moved to the business mailbox',
              kind: MessageKind.System,
              systemEvent: {
                type: 'moved_to_business_mailbox',
                actorId: ANA,
                value: message.senderIdentityId,
              },
              createdAt: atHour(message.hour),
            }
          : {
              id: messageId,
              conversationId,
              senderId: isFromCustomer ? customerId : message.senderId,
              senderIdentityId: isFromCustomer
                ? customerIdentityId
                : message.senderIdentityId,
              body: `${thread.label} ${messageIndex}`,
              createdAt: atHour(message.hour),
            },
      );
      if (message.isHiddenForAna) {
        await dataSource
          .getRepository(MessageHide)
          .insert({ userId: ANA, messageId });
      }
      if (message.isModerated) {
        await dataSource.getRepository(ContentModeration).insert({
          subjectType: MESSAGE_SUBJECT_TYPE,
          subjectId: messageId,
          hiddenAt: atHour(8),
        });
      }
    }
  }
}

function buildService(dataSource: DataSource): ConversationsService {
  const identityRepository = dataSource.getRepository(Identity);
  const identities = {
    isAllowedToActAs: jest.fn().mockResolvedValue(true),
    getByIds: (identityIds: string[]) =>
      identityIds.length
        ? identityRepository.find({ where: { id: In(identityIds) } })
        : Promise.resolve([]),
    describeIdentities: (identityIds: string[]) =>
      Promise.resolve(
        new Map(
          identityIds.map((identityId) => [
            identityId,
            {
              displayName: `Identity ${identityId}`,
              handle: null,
              avatarUrl: null,
            },
          ]),
        ),
      ),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
  };
  const usersService = { findById: jest.fn().mockResolvedValue(null) };
  const eventEmitter = { emit: jest.fn() };
  const core = new MessagingCoreService(
    dataSource.getRepository(Conversation),
    dataSource.getRepository(ConversationParticipant),
    dataSource.getRepository(Message),
    dataSource.getRepository(MessageReaction),
    dataSource.getRepository(ConversationPinnedMessage),
    dataSource.getRepository(MessageStar),
    dataSource.getRepository(MessageHide),
    dataSource.getRepository(ContentModeration),
    dataSource.getRepository(Profile),
    dataSource.getRepository(Sticker),
    dataSource,
    eventEmitter as unknown as EventEmitter2,
    usersService as unknown as UsersService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    identityBlocksAmong: jest.fn().mockResolvedValue([]),
  };
  const connectionsService = {
    acceptedSinceByCounterpart: jest.fn().mockResolvedValue(new Map()),
    allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
  };
  const preferencesService = {
    getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
  };
  const mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
  return new ConversationsService(
    dataSource.getRepository(Conversation),
    dataSource.getRepository(ConversationParticipant),
    dataSource.getRepository(Profile),
    core,
    blockFilter as unknown as BlockFilterService,
    eventEmitter as unknown as EventEmitter2,
    dataSource,
    mediaCropService as unknown as MediaCropService,
    connectionsService as unknown as ConnectionsService,
    preferencesService as unknown as PreferencesService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
}
