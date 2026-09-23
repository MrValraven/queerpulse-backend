import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ConversationMediaService } from './conversation-media.service';
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
import { seatExcludedFromMailboxPredicate } from './mailbox-seats';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13c: every message-level read surface a customer of a business
 * mailbox reaches, beyond the inbox row: the thread itself (reply quotes and
 * delivery ticks), the media gallery, search, the starred list, and the two
 * gates that decide whether a customer or staff member may act in the
 * thread at all. Each fixture seats several staff members of one listing
 * mailbox beside the customer and orders them so an arbitrary pick of one
 * seat gives the wrong answer.
 */

const CONVERSATION_ID = 'c-mailbox';
const CUSTOMER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const LISTING_IDENTITY_ID = 'identity-listing';
const STAFF_ID = 'staff-1';

const STAFF_PROFILE = {
  userId: STAFF_ID,
  firstName: 'Tiago',
  lastName: 'Costa',
  slug: 'tiago-costa',
  pronouns: null,
  avatarUrl: 'https://example.test/tiago.png',
  photoVisible: true,
};
const CUSTOMER_PROFILE = {
  userId: CUSTOMER_ID,
  firstName: 'Alex',
  lastName: 'Customer',
  slug: 'alex-customer',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};
const LISTING_DESCRIPTION = {
  displayName: 'Cafe Lisboa',
  handle: 'cafe-lisboa',
  avatarUrl: 'https://example.test/cafe.png',
};

function seat(
  overrides: Partial<ConversationParticipant> & { userId: string },
): ConversationParticipant {
  return {
    id: `p-${overrides.userId}`,
    conversationId: CONVERSATION_ID,
    identityId: LISTING_IDENTITY_ID,
    role: ConversationRole.Member,
    leftAt: null,
    clearedAt: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

const customerSeat = (overrides: Partial<ConversationParticipant> = {}) =>
  seat({ userId: CUSTOMER_ID, identityId: CUSTOMER_IDENTITY_ID, ...overrides });

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    senderId: STAFF_ID,
    senderIdentityId: LISTING_IDENTITY_ID,
    body: 'Your table is ready',
    replyToId: null,
    createdAt: new Date('2026-01-02T09:00:00.000Z'),
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

function identityStandIns() {
  return {
    identities: {
      getByIds: jest.fn().mockResolvedValue([
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: LISTING_IDENTITY_ID, kind: IdentityKind.Listing },
      ]),
      describeIdentities: jest
        .fn()
        .mockResolvedValue(
          new Map([[LISTING_IDENTITY_ID, LISTING_DESCRIPTION]]),
        ),
    },
    identityAttribution: {
      // The owner has switched staff names off: a customer is owed none.
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    },
  };
}

function expectNoStaffTrace(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('Tiago');
  expect(serialized).not.toContain('Costa');
  expect(serialized).not.toContain('tiago-costa');
  expect(serialized).not.toContain('tiago.png');
}

/** A real `MessagingCoreService` over stand-in repositories, for
 *  `toMessageResponses`. */
function buildCore(options: {
  seats: ConversationParticipant[];
  replyParents?: Message[];
}) {
  const empty = {} as Record<string, never>;
  const { identities, identityAttribution } = identityStandIns();
  const service = new MessagingCoreService(
    { findOne: jest.fn() } as unknown as Repository<Conversation>,
    {
      find: jest.fn().mockResolvedValue(options.seats),
    } as unknown as Repository<ConversationParticipant>,
    {
      find: jest.fn().mockResolvedValue(options.replyParents ?? []),
    } as unknown as Repository<Message>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<MessageReaction>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<ConversationPinnedMessage>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<MessageStar>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<MessageHide>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<ContentModeration>,
    {
      find: jest.fn().mockResolvedValue([STAFF_PROFILE, CUSTOMER_PROFILE]),
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    {
      findById: jest.fn().mockResolvedValue({ role: UserRole.Member }),
    } as unknown as UsersService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
  return service;
}

describe('Task 13c: the thread a customer reads', () => {
  it('quotes a business reply under the business name, with no trace of the staff member who typed it', async () => {
    const parent = messageRow({ id: 'm-parent' });
    const reply = messageRow({
      id: 'm-reply',
      senderId: CUSTOMER_ID,
      senderIdentityId: CUSTOMER_IDENTITY_ID,
      body: 'Thank you',
      replyToId: 'm-parent',
    });
    const core = buildCore({
      seats: [customerSeat(), seat({ userId: STAFF_ID })],
      replyParents: [parent],
    });

    const [response] = await core.toMessageResponses(
      [reply],
      CUSTOMER_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response?.replyTo?.senderName).toBe('Cafe Lisboa');
    expectNoStaffTrace(response);
  });

  it("marks a customer's message delivered once ANY staff seat has it, whatever a newly seated colleague has acked", async () => {
    const core = buildCore({
      seats: [
        customerSeat(),
        // Seated after the message and never acked anything, ordered first.
        seat({ userId: 'staff-new', deliveredAt: null }),
        seat({
          userId: STAFF_ID,
          deliveredAt: new Date('2026-01-02T10:00:00.000Z'),
        }),
      ],
    });

    const [response] = await core.toMessageResponses(
      [
        messageRow({
          senderId: CUSTOMER_ID,
          senderIdentityId: CUSTOMER_IDENTITY_ID,
        }),
      ],
      CUSTOMER_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response?.deliveredAt).toBe('2026-01-02T10:00:00.000Z');
  });

  it("marks a staff member's message delivered from the CUSTOMER's watermark, ignoring a colleague who has acked nothing", async () => {
    const core = buildCore({
      seats: [
        seat({ userId: STAFF_ID }),
        seat({ userId: 'staff-2', deliveredAt: null }),
        customerSeat({ deliveredAt: new Date('2026-01-02T10:00:00.000Z') }),
      ],
    });

    const [response] = await core.toMessageResponses(
      [messageRow()],
      STAFF_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response?.deliveredAt).toBe('2026-01-02T10:00:00.000Z');
  });
});

/**
 * A stand-in for the participant repository's query builders, each call a
 * fresh query that records its own clauses. The database it stands for
 * holds a block between the caller and one seat of the thread, so:
 * - the staff-exclusion query (`"blocked_staff_seat"`) reports
 *   `isCallerExcludedStaff`;
 * - the write gate's person-block query reports a block unless one of its
 *   clauses NEGATES the mailbox predicate. A clause carrying the predicate
 *   without `NOT` would make blocks apply only on mailbox threads, and this
 *   stand-in then reports the block.
 */
function seatQueries(options: { isCallerExcludedStaff: boolean }) {
  const recordedClauses: string[][] = [];
  const createQueryBuilder = jest.fn(() => {
    const clauses: string[] = [];
    recordedClauses.push(clauses);
    const query = {} as Record<string, jest.Mock>;
    const self = () => query;
    query.innerJoin = jest.fn(self);
    query.where = jest.fn(self);
    query.andWhere = jest.fn((sql: string) => {
      clauses.push(sql);
      return query;
    });
    query.getExists = jest.fn(() => {
      if (clauses.some((sql) => sql.includes('"blocked_staff_seat"'))) {
        return Promise.resolve(options.isCallerExcludedStaff);
      }
      const isMailboxExempt = clauses.some(
        (sql) =>
          sql.startsWith('NOT EXISTS (') &&
          sql.includes(`"mailbox_identity"."kind" <> 'profile'`),
      );
      return Promise.resolve(!isMailboxExempt);
    });
    return query;
  });
  return { createQueryBuilder, recordedClauses };
}

describe('Task 13c: the write gate on a business thread', () => {
  function coreFor(
    callerSeat: ConversationParticipant,
    isCallerExcludedStaff: boolean,
  ) {
    const core = Object.create(
      MessagingCoreService.prototype,
    ) as MessagingCoreService;
    const queries = seatQueries({ isCallerExcludedStaff });
    Object.assign(core, {
      participants: {
        findOne: jest.fn().mockResolvedValue(callerSeat),
        createQueryBuilder: queries.createQueryBuilder,
      },
    });
    return { core, queries };
  }

  it('lets a customer who personally blocked one staff member keep acting in the business thread', async () => {
    const { core, queries } = coreFor(customerSeat(), false);

    await expect(
      core.requireActiveParticipant(CONVERSATION_ID, CUSTOMER_ID),
    ).resolves.toMatchObject({ userId: CUSTOMER_ID });
    // Task 13c fix round 1: the exemption is a NEGATED mailbox predicate.
    expect(
      queries.recordedClauses
        .flat()
        .some(
          (sql) =>
            sql.startsWith('NOT EXISTS (') &&
            sql.includes(`"mailbox_identity"."kind" <> 'profile'`),
        ),
    ).toBe(true);
  });

  it('refuses a staff member blocked with the customer on every read', async () => {
    const { core } = coreFor(seat({ userId: STAFF_ID }), true);

    await expect(
      core.requireParticipant(CONVERSATION_ID, STAFF_ID),
    ).rejects.toThrow('You are not a participant');
  });

  it('refuses a staff member blocked with the customer on every write', async () => {
    const { core } = coreFor(seat({ userId: STAFF_ID }), true);

    await expect(
      core.requireActiveParticipant(CONVERSATION_ID, STAFF_ID),
    ).rejects.toThrow('You are not a participant');
  });

  it("asks the database about the caller's own staff seat, negated, with blocks in both directions", async () => {
    const { core, queries } = coreFor(seat({ userId: STAFF_ID }), false);

    await core.requireParticipant(CONVERSATION_ID, STAFF_ID);

    const exclusionClause = queries.recordedClauses
      .flat()
      .find((sql) => sql.includes('"blocked_staff_seat"'));
    expect(exclusionClause).toContain(
      '"blocked_staff_seat"."user_id" = seat.user_id',
    );
    expect(exclusionClause).toContain(
      '"staff_customer_block"."blocker_id" = "blocked_staff_seat"."user_id"',
    );
    expect(exclusionClause).toContain(
      '"staff_customer_block"."blocked_id" = "blocked_staff_seat"."user_id"',
    );
  });
});

describe('Task 13c: the unread badge', () => {
  function badgeClausesFor(userId: string) {
    const badgeClauses: string[] = [];
    const badgeQuery = {} as Record<string, jest.Mock>;
    const self = () => badgeQuery;
    for (const method of ['select', 'innerJoin', 'where', 'setParameter']) {
      badgeQuery[method] = jest.fn(self);
    }
    badgeQuery.andWhere = jest.fn((sql: string) => {
      badgeClauses.push(sql);
      return badgeQuery;
    });
    badgeQuery.getRawOne = jest.fn().mockResolvedValue({ count: '1' });
    const core = Object.create(
      MessagingCoreService.prototype,
    ) as MessagingCoreService;
    Object.assign(core, {
      participants: { createQueryBuilder: jest.fn(() => badgeQuery) },
    });
    return { core, badgeClauses, userId };
  }

  it('keeps counting a business thread for a customer who personally blocked one staff member, as the inbox shows it', async () => {
    const { core, badgeClauses } = badgeClausesFor(CUSTOMER_ID);

    await core.unreadConversationCount(CUSTOMER_ID);

    const blockClause = badgeClauses.find((sql) =>
      sql.includes('"__unread_block"'),
    );
    // Task 13c fix round 1: the mailbox predicate is NEGATED.
    expect(blockClause).toMatch(
      /AND NOT EXISTS \(\s+SELECT 1 FROM "conversation_participants" "mailbox_seat"/,
    );
  });

  it('stops counting the thread for a staff member blocked with its customer', async () => {
    const { core, badgeClauses } = badgeClausesFor(STAFF_ID);

    await core.unreadConversationCount(STAFF_ID);

    const exclusionClause = badgeClauses.find((sql) =>
      sql.includes('"blocked_staff_seat"'),
    );
    expect(exclusionClause).toBe(
      `NOT ${seatExcludedFromMailboxPredicate('p.conversation_id', ':userId')}`,
    );
  });
});

/** A real `MessagesService` send gate over a customer-initiated, unopened
 *  mailbox thread with a connected colleague ordered first. */
function buildMessagesService() {
  const conversation = {
    id: CONVERSATION_ID,
    kind: ConversationKind.Direct,
    isOfficial: false,
    initiatorUserId: CUSTOMER_ID,
    openedAt: null as Date | null,
  };
  const callerSeats: Record<string, ConversationParticipant> = {
    [STAFF_ID]: seat({ userId: STAFF_ID }),
    [CUSTOMER_ID]: customerSeat(),
  };
  // A colleague ordered FIRST who IS personally connected to the customer.
  const connectedColleague = seat({ userId: 'staff-connected' });
  const allSeats = [
    connectedColleague,
    callerSeats[STAFF_ID]!,
    callerSeats[CUSTOMER_ID]!,
  ];
  const participants = {
    find: jest.fn().mockResolvedValue(allSeats),
    // The pre-Task-13c gate's unordered pick of "the other participant".
    findOne: jest.fn().mockResolvedValue(connectedColleague),
  };
  const { identities } = identityStandIns();
  const conversations = {
    findOne: jest.fn(() => Promise.resolve({ ...conversation })),
    update: jest.fn((_id: string, values: { openedAt: Date }) => {
      conversation.openedAt = values.openedAt;
      return Promise.resolve(undefined);
    }),
  };
  const core = {
    requireParticipant: jest.fn((_conversationId: string, userId: string) =>
      Promise.resolve(callerSeats[userId]),
    ),
    loadDirectThreadSeats: (
      conversationId: string,
      callerSeat: ConversationParticipant,
    ) =>
      MessagingCoreService.prototype.loadDirectThreadSeats.call(
        { participants, identities },
        conversationId,
        callerSeat,
      ),
    postMessage: jest
      .fn()
      .mockResolvedValue({ response: { id: 'm-new' }, isNew: false }),
  };
  const blockFilter = {
    isBlockedEitherWay: jest.fn().mockResolvedValue(false),
  };
  const service = Object.create(MessagesService.prototype) as MessagesService;
  Object.assign(service, {
    usersService: {
      findById: jest.fn().mockResolvedValue({ status: UserStatus.Active }),
      liftExpiredRestriction: jest.fn().mockResolvedValue(false),
    },
    core,
    conversations,
    participants,
    blockFilter,
    connectionsService: {
      areConnected: jest.fn((_userId: string, otherUserId: string) =>
        Promise.resolve(
          otherUserId === CUSTOMER_ID || otherUserId === 'staff-connected',
        ),
      ),
    },
  });
  return { service, conversations, conversation, blockFilter };
}

describe('Task 13c: the send-time gate on a business thread', () => {
  it("opens a customer-initiated thread on a staff member's first reply, with a connected colleague ordered first, so the customer can then send", async () => {
    const { service, conversations } = buildMessagesService();
    // Only the colleague ordered first is personally connected to the
    // customer in this fixture.
    (
      service as unknown as {
        connectionsService: { areConnected: jest.Mock };
      }
    ).connectionsService.areConnected.mockImplementation(
      (userId: string, otherUserId: string) =>
        Promise.resolve(
          (userId === STAFF_ID && otherUserId === 'staff-connected') ||
            (userId === 'staff-connected' && otherUserId === CUSTOMER_ID),
        ),
    );

    await service.sendMessageWithOutcome(CONVERSATION_ID, STAFF_ID, 'Hello!');

    expect(conversations.update).toHaveBeenCalledWith(
      CONVERSATION_ID,
      expect.objectContaining({ openedAt: expect.any(Date) as Date }),
    );
    await expect(
      service.sendMessageWithOutcome(CONVERSATION_ID, CUSTOMER_ID, 'Thanks!'),
    ).resolves.toMatchObject({ response: { id: 'm-new' } });
  });
});

describe('Task 13c fix round 1: sending around a personal block', () => {
  function sendGateWithCustomerBlockingColleague() {
    const built = buildMessagesService();
    // The customer blocked the colleague `staff-connected`, and the database
    // reports that block for either order of the pair.
    built.blockFilter.isBlockedEitherWay.mockImplementation(
      (userId: string, otherUserId: string) =>
        Promise.resolve(
          [userId, otherUserId].includes(CUSTOMER_ID) &&
            [userId, otherUserId].includes('staff-connected'),
        ),
    );
    return built;
  }

  // Regression guard, requested by review: pinned behaviour.
  it('lets a customer who blocked a staff member still send to the business', async () => {
    const { service, conversation } = sendGateWithCustomerBlockingColleague();
    conversation.openedAt = new Date('2026-01-01T01:00:00.000Z');

    await expect(
      service.sendMessageWithOutcome(CONVERSATION_ID, CUSTOMER_ID, 'Hi'),
    ).resolves.toMatchObject({ response: { id: 'm-new' } });
  });

  // Regression guard: the business keeps answering through a colleague.
  it('lets an unblocked colleague answer, and open, the thread while another staff member is blocked', async () => {
    const { service, conversations } = sendGateWithCustomerBlockingColleague();

    await service.sendMessageWithOutcome(CONVERSATION_ID, STAFF_ID, 'Hello!');

    expect(conversations.update).toHaveBeenCalledWith(
      CONVERSATION_ID,
      expect.objectContaining({ openedAt: expect.any(Date) as Date }),
    );
  });
});

describe('Task 13c: search and the starred list', () => {
  function listCore() {
    const { identities, identityAttribution } = identityStandIns();
    const participants = {
      find: jest
        .fn()
        .mockResolvedValue([
          seat({ userId: STAFF_ID }),
          seat({ userId: 'staff-2' }),
          customerSeat(),
        ]),
    };
    const profiles = {
      find: jest.fn().mockResolvedValue([STAFF_PROFILE, CUSTOMER_PROFILE]),
    };
    const core = Object.assign(Object.create(MessagingCoreService.prototype), {
      participants,
      profiles,
      identities,
      identityAttribution,
    }) as MessagingCoreService;
    return { core, participants, profiles };
  }

  function chainable(terminal: Record<string, jest.Mock>) {
    const queryBuilder = { ...terminal } as Record<string, jest.Mock>;
    const self = () => queryBuilder;
    for (const method of [
      'where',
      'andWhere',
      'innerJoin',
      'leftJoin',
      'addSelect',
      'orderBy',
      'addOrderBy',
      'take',
      'limit',
      'select',
    ]) {
      queryBuilder[method] = jest.fn(self);
    }
    return queryBuilder;
  }

  const conversation = {
    id: CONVERSATION_ID,
    kind: ConversationKind.Direct,
    isOfficial: false,
    title: null,
    avatarUrl: null,
  };

  it("files a customer's search hit under the business and names the business as its sender", async () => {
    const { core, participants, profiles } = listCore();
    const service = Object.create(MessagesService.prototype) as MessagesService;
    Object.assign(service, {
      messages: {
        createQueryBuilder: jest.fn(() =>
          chainable({ getMany: jest.fn().mockResolvedValue([messageRow()]) }),
        ),
      },
      blockFilter: { excludeBlocked: jest.fn() },
      conversations: { find: jest.fn().mockResolvedValue([conversation]) },
      participants,
      profiles,
      core,
    });

    const result = await service.searchMessages(CUSTOMER_ID, 'table');

    expect(result.hits[0]?.sender.displayName).toBe('Cafe Lisboa');
    expect(result.conversations[0]?.otherParticipant?.displayName).toBe(
      'Cafe Lisboa',
    );
    expectNoStaffTrace(result);
  });

  it("files a customer's starred business message under the business and names the business as its sender", async () => {
    const { core, participants, profiles } = listCore();
    const starredQuery = chainable({
      getRawAndEntities: jest.fn().mockResolvedValue({
        entities: [messageRow()],
        raw: [{ m_id: 'm1', cursor_starred_at: '2026-01-02T09:00:00.000000Z' }],
      }),
    });
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, {
      messages: { createQueryBuilder: jest.fn(() => starredQuery) },
      stars: {
        find: jest.fn().mockResolvedValue([
          {
            messageId: 'm1',
            createdAt: new Date('2026-01-02T09:30:00.000Z'),
          },
        ]),
      },
      conversations: { find: jest.fn().mockResolvedValue([conversation]) },
      participants,
      profiles,
      core,
    });

    const result = await service.listStarredMessages(CUSTOMER_ID);

    expect(result.items[0]?.sender.displayName).toBe('Cafe Lisboa');
    expect(result.conversations[0]?.otherParticipant?.displayName).toBe(
      'Cafe Lisboa',
    );
    expectNoStaffTrace(result);
  });

  it('finds nothing from a thread whose customer is blocked with the searching staff member', async () => {
    const { core, participants, profiles } = listCore();
    const searchQuery = chainable({ getMany: jest.fn().mockResolvedValue([]) });
    const service = Object.create(MessagesService.prototype) as MessagesService;
    Object.assign(service, {
      messages: { createQueryBuilder: jest.fn(() => searchQuery) },
      blockFilter: { excludeBlocked: jest.fn() },
      participants,
      profiles,
      core,
    });

    await service.searchMessages(STAFF_ID, 'table');

    const exclusionClause = (searchQuery.andWhere!.mock.calls as [string][])
      .map(([sql]) => sql)
      .find((sql) => sql.includes('"blocked_staff_seat"'));
    expect(exclusionClause).toBe(
      `NOT ${seatExcludedFromMailboxPredicate('m.conversation_id', ':userId')}`,
    );
  });

  it('lists nothing starred from a thread whose customer is blocked with the staff member', async () => {
    const { core, participants, profiles } = listCore();
    const starredQuery = chainable({
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
    });
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, {
      messages: { createQueryBuilder: jest.fn(() => starredQuery) },
      participants,
      profiles,
      core,
    });

    await service.listStarredMessages(STAFF_ID);

    const exclusionClause = (starredQuery.andWhere!.mock.calls as [string][])
      .map(([sql]) => sql)
      .find((sql) => sql.includes('"blocked_staff_seat"'));
    expect(exclusionClause).toBe(
      `NOT ${seatExcludedFromMailboxPredicate('m.conversation_id', ':userId')}`,
    );
  });

  it("never matches a staff member's personal name against a message they sent as the business, or against their seat", async () => {
    const { core, participants, profiles } = listCore();
    const starredQuery = chainable({
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
    });
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, {
      messages: { createQueryBuilder: jest.fn(() => starredQuery) },
      participants,
      profiles,
      core,
    });

    await service.listStarredMessages(CUSTOMER_ID, { q: 'Tiago' });

    const nameClause = (starredQuery.andWhere!.mock.calls as [string][])
      .map(([sql]) => sql)
      .find((sql) => sql.includes('"sender_profile"'));
    expect(nameClause).toContain(`"sender_identity"."kind" = 'profile'`);
    expect(nameClause).toContain(`"op_identity"."kind" = 'profile'`);
  });
});

describe('Task 13c: the media gallery', () => {
  it('selects the identity each message was sent as, so a business photo is not credited to the staff member who sent it', async () => {
    const selections: string[][] = [];
    const galleryQuery = {} as Record<string, jest.Mock>;
    const self = () => galleryQuery;
    for (const method of [
      'where',
      'andWhere',
      'addSelect',
      'orderBy',
      'addOrderBy',
      'take',
    ]) {
      galleryQuery[method] = jest.fn(self);
    }
    galleryQuery.select = jest.fn((columns: string[]) => {
      selections.push(columns);
      return galleryQuery;
    });
    galleryQuery.getRawAndEntities = jest
      .fn()
      .mockResolvedValue({ entities: [], raw: [] });
    const core = {
      requireParticipant: jest.fn().mockResolvedValue(customerSeat()),
      toMessageResponses: jest.fn().mockResolvedValue([]),
    };
    const service = new ConversationMediaService(
      {
        createQueryBuilder: jest.fn(() => galleryQuery),
      } as unknown as Repository<Message>,
      core as unknown as MessagingCoreService,
    );

    await service.listConversationMedia(CONVERSATION_ID, CUSTOMER_ID, {
      kind: 'media' as never,
    });

    expect(selections[0]).toContain('m.senderIdentityId');
  });
});
