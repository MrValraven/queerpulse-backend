import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { Message, MessageKind } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import {
  isCoveredByMailboxStaffFloor,
  mailboxStaffHistoryFloorCoversPredicate,
} from './mailbox-seats';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13h: a seat's history floor (`cleared_at`) reaches reply quotes.
 *
 * A personal thread moved into a business mailbox gives each co-manager a
 * floor at the first enquiry, so the owner's and the customer's earlier
 * private conversation stays with them. A later reply quoting one of those
 * earlier messages used to hand every co-manager the parent's snippet,
 * author, thumbnail and file name. The quote now renders as a missing parent
 * for a mailbox staff seat whose floor covers it, and in full for everyone
 * else. Fix round 1: a "clear chat" on a seat that speaks for the member
 * themself (a personal thread, a group, the customer's own seat) keeps
 * quoting exactly as before this task.
 *
 * The parent query runs against a fixture: the stand-in builder accepts only
 * the clauses it knows and answers the floor clause through its in-memory
 * twin, `isCoveredByMailboxStaffFloor`. The real SQL is exercised against
 * Postgres in the task report's probe.
 */

const IDENTITY_KIND_BY_ID = new Map<string, IdentityKind>();

const CONVERSATION_ID = 'c-moved';
const OWNER_ID = 'owner-1';
const CO_MANAGER_ID = 'co-manager-1';
const CUSTOMER_ID = 'customer-1';
const FRIEND_ID = 'friend-1';
const LISTING_IDENTITY_ID = 'identity-listing';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const FRIEND_IDENTITY_ID = 'identity-friend';
IDENTITY_KIND_BY_ID.set(LISTING_IDENTITY_ID, IdentityKind.Listing);
IDENTITY_KIND_BY_ID.set(CUSTOMER_IDENTITY_ID, IdentityKind.Profile);
IDENTITY_KIND_BY_ID.set(FRIEND_IDENTITY_ID, IdentityKind.Profile);

const EXPECTED_FLOOR_CLAUSE = mailboxStaffHistoryFloorCoversPredicate(
  'parent.created_at',
  'seat',
);

const HISTORY_FLOOR = new Date('2026-09-10T12:00:00.000Z');
const PRE_FLOOR = new Date('2026-09-10T11:00:00.000Z');
const POST_FLOOR = new Date('2026-09-10T13:00:00.000Z');

const PRIVATE_BODY = 'R1 PRIVATE old customer secret';
const PRIVATE_PHOTO_KEY =
  'message-images/aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001.jpg';
const PRIVATE_DOCUMENT_NAME = 'private-lease.pdf';

const CUSTOMER_PROFILE = {
  userId: CUSTOMER_ID,
  firstName: 'Marta',
  lastName: 'Silva',
  slug: 'marta-silva',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};
const FRIEND_PROFILE = {
  userId: FRIEND_ID,
  firstName: 'Joana',
  lastName: 'Reis',
  slug: 'joana-reis',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

function seat(
  userId: string,
  identityId: string,
  clearedAt: Date | null = null,
): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId,
    role: ConversationRole.Member,
    leftAt: null,
    clearedAt,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
  } as unknown as ConversationParticipant;
}

function messageRow(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    senderId: CUSTOMER_ID,
    senderIdentityId: CUSTOMER_IDENTITY_ID,
    body: '',
    replyToId: null,
    createdAt: POST_FLOOR,
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.User,
    systemEvent: null,
    attachment: null,
    ...overrides,
  } as unknown as Message;
}

/** A real `MessagingCoreService` over stand-in repositories, for
 *  `toMessageResponses`, shaped like `mailbox-message-surfaces.spec.ts`. */
function buildCore(
  seats: ConversationParticipant[],
  replyParents: Message[],
  isGroupConversation = false,
) {
  const empty = {} as Record<string, never>;
  const findNothing = { find: jest.fn().mockResolvedValue([]) };
  const parameters: Record<string, unknown> = {};
  const clauses: string[] = [];
  const parentQuery = {
    withDeleted: () => parentQuery,
    select: () => parentQuery,
    innerJoin: (
      _entity: unknown,
      _alias: string,
      _condition: string,
      joinParameters?: Record<string, unknown>,
    ) => {
      Object.assign(parameters, joinParameters);
      return parentQuery;
    },
    where: (clause: string, whereParameters?: Record<string, unknown>) => {
      clauses.push(clause);
      Object.assign(parameters, whereParameters);
      return parentQuery;
    },
    andWhere: (clause: string) => {
      clauses.push(clause);
      return parentQuery;
    },
    getRawMany: () => {
      const viewerSeat = seats.find(
        (candidate) => candidate.id === parameters.viewerSeatId,
      )!;
      let rows = replyParents.filter((parent) =>
        (parameters.parentIds as string[]).includes(parent.id),
      );
      for (const clause of clauses) {
        if (clause === 'parent.id IN (:...parentIds)') {
          continue;
        } else if (clause === EXPECTED_FLOOR_CLAUSE) {
          rows = rows.filter((parent) =>
            isCoveredByMailboxStaffFloor(parent.createdAt, {
              clearedAt: viewerSeat.clearedAt,
              identityKind: IDENTITY_KIND_BY_ID.get(viewerSeat.identityId),
              isGroupConversation,
              isOfficialConversation: false,
            }),
          );
        } else {
          throw new Error(`Unrecognised parent clause: ${clause}`);
        }
      }
      return Promise.resolve(rows.map((parent) => ({ parentId: parent.id })));
    },
  };
  return new MessagingCoreService(
    { findOne: jest.fn() } as unknown as Repository<Conversation>,
    {
      find: jest.fn().mockResolvedValue(seats),
    } as unknown as Repository<ConversationParticipant>,
    {
      find: jest.fn().mockResolvedValue(replyParents),
      createQueryBuilder: jest.fn(() => parentQuery),
    } as unknown as Repository<Message>,
    findNothing as unknown as Repository<MessageReaction>,
    findNothing as unknown as Repository<ConversationPinnedMessage>,
    findNothing as unknown as Repository<MessageStar>,
    findNothing as unknown as Repository<MessageHide>,
    findNothing as unknown as Repository<ContentModeration>,
    {
      find: jest.fn().mockResolvedValue([CUSTOMER_PROFILE, FRIEND_PROFILE]),
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    {
      findById: jest.fn().mockResolvedValue({ role: UserRole.Member }),
    } as unknown as UsersService,
    {
      getByIds: jest.fn().mockResolvedValue([
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: FRIEND_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: LISTING_IDENTITY_ID, kind: IdentityKind.Listing },
      ]),
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
    } as unknown as IdentitiesService,
    {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    } as unknown as IdentityAttributionService,
  );
}

const movedThreadSeats = () => [
  seat(OWNER_ID, LISTING_IDENTITY_ID),
  seat(CUSTOMER_ID, CUSTOMER_IDENTITY_ID),
  seat(CO_MANAGER_ID, LISTING_IDENTITY_ID, HISTORY_FLOOR),
];

const privateTextParent = () =>
  messageRow({ id: 'm-private', body: PRIVATE_BODY, createdAt: PRE_FLOOR });

const privatePhotoParent = () =>
  messageRow({
    id: 'm-private-photo',
    kind: MessageKind.Image,
    createdAt: PRE_FLOOR,
    attachment: {
      url: PRIVATE_PHOTO_KEY,
      previewUrl: PRIVATE_PHOTO_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    },
  });

const privateDocumentParent = () =>
  messageRow({
    id: 'm-private-document',
    kind: MessageKind.Document,
    createdAt: PRE_FLOOR,
    attachment: {
      url: 'message-documents/aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000002.pdf',
      fileName: PRIVATE_DOCUMENT_NAME,
      byteSize: 1024,
      contentType: 'application/pdf',
      provider: 'upload',
    },
  });

const replyTo = (parentId: string) =>
  messageRow({
    id: `reply-to-${parentId}`,
    senderId: OWNER_ID,
    senderIdentityId: LISTING_IDENTITY_ID,
    body: 'About this',
    replyToId: parentId,
    createdAt: POST_FLOOR,
  });

async function renderFor(
  viewerId: string,
  seats: ConversationParticipant[],
  parent: Message,
) {
  const core = buildCore(seats, [parent]);
  const [response] = await core.toMessageResponses(
    [replyTo(parent.id)],
    viewerId,
    false,
    ConversationKind.Direct,
  );
  return response!;
}

const UNAVAILABLE_QUOTE_FIELDS = {
  snippet: '',
  senderName: 'Someone',
  senderIsFormerMember: false,
  deleted: true,
  kind: 'user',
  thumbnailUrl: null,
  fileName: null,
};

describe('Task 13h: reply quotes honour the viewer history floor', () => {
  // A quote's thumbnail resolves the stored key through `toImageUrl`, which
  // needs its base wired.
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('gives a co-manager an unavailable quote for a pre-floor text parent, with no snippet or name', async () => {
    const parent = privateTextParent();

    const response = await renderFor(CO_MANAGER_ID, movedThreadSeats(), parent);

    expect(response.replyTo).toEqual({
      id: parent.id,
      ...UNAVAILABLE_QUOTE_FIELDS,
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('Marta');
  });

  it('gives a co-manager no thumbnail of a pre-floor photo parent', async () => {
    const response = await renderFor(
      CO_MANAGER_ID,
      movedThreadSeats(),
      privatePhotoParent(),
    );

    expect(response.replyTo).toMatchObject(UNAVAILABLE_QUOTE_FIELDS);
    expect(JSON.stringify(response)).not.toContain(
      'bbbbbbbb-0000-4000-8000-000000000001',
    );
  });

  it('gives a co-manager no file name of a pre-floor document parent', async () => {
    const response = await renderFor(
      CO_MANAGER_ID,
      movedThreadSeats(),
      privateDocumentParent(),
    );

    expect(response.replyTo).toMatchObject(UNAVAILABLE_QUOTE_FIELDS);
    expect(JSON.stringify(response)).not.toContain(PRIVATE_DOCUMENT_NAME);
  });

  it('gives the owner, who holds no floor, the full quote of the same parent', async () => {
    const response = await renderFor(
      OWNER_ID,
      movedThreadSeats(),
      privateTextParent(),
    );

    expect(response.replyTo).toMatchObject({
      snippet: PRIVATE_BODY,
      senderName: 'Marta Silva',
      deleted: false,
    });
  });

  it('gives the owner the thumbnail and file name the co-manager is refused', async () => {
    const photoQuote = await renderFor(
      OWNER_ID,
      movedThreadSeats(),
      privatePhotoParent(),
    );
    const documentQuote = await renderFor(
      OWNER_ID,
      movedThreadSeats(),
      privateDocumentParent(),
    );

    expect(photoQuote.replyTo?.thumbnailUrl).toContain(
      'bbbbbbbb-0000-4000-8000-000000000001',
    );
    expect(documentQuote.replyTo?.fileName).toBe(PRIVATE_DOCUMENT_NAME);
  });

  it('quotes a post-floor parent to the co-manager in full', async () => {
    const parent = messageRow({
      id: 'm-after',
      body: 'After the enquiry',
      createdAt: new Date('2026-09-10T12:30:00.000Z'),
    });

    const response = await renderFor(CO_MANAGER_ID, movedThreadSeats(), parent);

    expect(response.replyTo).toMatchObject({
      snippet: 'After the enquiry',
      deleted: false,
    });
  });

  it('hides a parent stamped exactly on the floor, since the floor is inclusive', async () => {
    const parent = messageRow({
      id: 'm-on-floor',
      body: 'On the floor',
      createdAt: new Date(HISTORY_FLOOR.getTime()),
    });

    const response = await renderFor(CO_MANAGER_ID, movedThreadSeats(), parent);

    expect(response.replyTo).toMatchObject(UNAVAILABLE_QUOTE_FIELDS);
  });

  it('keeps the full quote for the customer after the customer cleared the mailbox thread', async () => {
    const seats = [
      seat(OWNER_ID, LISTING_IDENTITY_ID),
      seat(CUSTOMER_ID, CUSTOMER_IDENTITY_ID, HISTORY_FLOOR),
      seat(CO_MANAGER_ID, LISTING_IDENTITY_ID, HISTORY_FLOOR),
    ];

    const response = await renderFor(CUSTOMER_ID, seats, privateTextParent());

    expect(response.replyTo).toMatchObject({
      snippet: PRIVATE_BODY,
      deleted: false,
    });
  });

  it('keeps the full quote of a cleared parent for a personal-thread member who cleared the chat, as before this task', async () => {
    const seats = [
      seat(CUSTOMER_ID, CUSTOMER_IDENTITY_ID),
      seat(FRIEND_ID, FRIEND_IDENTITY_ID, HISTORY_FLOOR),
    ];
    const parent = messageRow({
      id: 'm-cleared',
      senderId: FRIEND_ID,
      senderIdentityId: FRIEND_IDENTITY_ID,
      body: 'Something I cleared',
      createdAt: PRE_FLOOR,
    });
    const reply = messageRow({
      id: 'm-reply',
      body: 'Replying to that',
      replyToId: parent.id,
    });
    const core = buildCore(seats, [parent]);

    const [friendView] = await core.toMessageResponses(
      [reply],
      FRIEND_ID,
      false,
      ConversationKind.Direct,
    );

    expect(friendView!.replyTo).toMatchObject({
      snippet: 'Something I cleared',
      senderName: 'Joana Reis',
      deleted: false,
    });
  });

  it('keeps the full quote of a cleared parent for a group member who cleared the chat, as before this task', async () => {
    const seats = [
      seat(CUSTOMER_ID, CUSTOMER_IDENTITY_ID),
      seat(FRIEND_ID, FRIEND_IDENTITY_ID, HISTORY_FLOOR),
    ];
    const parent = messageRow({
      id: 'm-group-cleared',
      body: 'Group message the friend cleared',
      createdAt: PRE_FLOOR,
    });
    const reply = messageRow({
      id: 'm-group-reply',
      body: 'Replying in the group',
      replyToId: parent.id,
    });
    const core = buildCore(seats, [parent], true);

    const [friendView] = await core.toMessageResponses(
      [reply],
      FRIEND_ID,
      false,
      ConversationKind.Group,
    );

    expect(friendView!.replyTo).toMatchObject({
      snippet: 'Group message the friend cleared',
      deleted: false,
    });
  });
});

describe('Task 13h: the one definition of the history floor', () => {
  const staffSeat = (clearedAt: Date | null) => ({
    clearedAt,
    identityKind: IdentityKind.Listing,
    isGroupConversation: false,
    isOfficialConversation: false,
  });

  it('compares in SQL, inclusively, on the seat floor', () => {
    expect(EXPECTED_FLOOR_CLAUSE).toContain('seat.cleared_at IS NOT NULL');
    expect(EXPECTED_FLOOR_CLAUSE).toContain(
      'parent.created_at <= seat.cleared_at',
    );
  });

  // Pinned by hand, independently of the function, so dropping the
  // staff-seat condition from the SQL fails here even though every fixture
  // above recomputes the clause from the same source.
  it('holds only for a mailbox staff seat of a direct, non-official thread', () => {
    for (const fragment of [
      '"floor_staff_identity"."id" = seat.identity_id',
      `"floor_staff_identity"."kind" <> 'profile'`,
      '"floor_staff_conversation"."id" = seat.conversation_id',
      `"floor_staff_conversation"."kind" <> 'group'`,
      '"floor_staff_conversation"."is_official" = false',
    ]) {
      expect(EXPECTED_FLOOR_CLAUSE).toContain(fragment);
    }
  });

  it('covers a message at or before a staff floor, and nothing under no floor', () => {
    expect(
      isCoveredByMailboxStaffFloor(PRE_FLOOR, staffSeat(HISTORY_FLOOR)),
    ).toBe(true);
    expect(
      isCoveredByMailboxStaffFloor(HISTORY_FLOOR, staffSeat(HISTORY_FLOOR)),
    ).toBe(true);
    expect(
      isCoveredByMailboxStaffFloor(POST_FLOOR, staffSeat(HISTORY_FLOOR)),
    ).toBe(false);
    expect(isCoveredByMailboxStaffFloor(PRE_FLOOR, staffSeat(null))).toBe(
      false,
    );
  });

  it('never covers anything for a profile seat, a group seat or an official thread', () => {
    const base = staffSeat(HISTORY_FLOOR);
    expect(
      isCoveredByMailboxStaffFloor(PRE_FLOOR, {
        ...base,
        identityKind: IdentityKind.Profile,
      }),
    ).toBe(false);
    expect(
      isCoveredByMailboxStaffFloor(PRE_FLOOR, {
        ...base,
        isGroupConversation: true,
      }),
    ).toBe(false);
    expect(
      isCoveredByMailboxStaffFloor(PRE_FLOOR, {
        ...base,
        isOfficialConversation: true,
      }),
    ).toBe(false);
    expect(
      isCoveredByMailboxStaffFloor(PRE_FLOOR, {
        ...base,
        identityKind: undefined,
      }),
    ).toBe(false);
  });

  it('errs toward hiding inside the floor millisecond, where node-pg truncation meets', () => {
    // A floor at .122999 and a message at .122500 both load as .122, so the
    // message, truly before the floor, is covered. A message at .122800
    // after a floor at .122100 also loads as .122 and is covered too: the
    // rounding hides it. A message truly at or before the floor is always
    // hidden.
    const truncatedFloor = new Date('2026-09-10T12:00:00.122Z');
    const truncatedMessage = new Date('2026-09-10T12:00:00.122Z');
    const nextMillisecond = new Date('2026-09-10T12:00:00.123Z');

    expect(
      isCoveredByMailboxStaffFloor(truncatedMessage, staffSeat(truncatedFloor)),
    ).toBe(true);
    expect(
      isCoveredByMailboxStaffFloor(nextMillisecond, staffSeat(truncatedFloor)),
    ).toBe(false);
  });
});
