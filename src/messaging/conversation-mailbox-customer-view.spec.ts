import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';
import { MessageKind } from './entities/message.entity';
import { seatExcludedFromMailboxPredicate } from './mailbox-seats';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13c: the customer's view of a business mailbox thread, and the
 * person-to-person block rule on one, across the inbox read surface.
 *
 * A customer messaging a business sees the business and never learns which
 * or how many humans answer for it. Every fixture seats several staff
 * members of one listing mailbox, each on their own row carrying the
 * mailbox identity, beside the customer's own profile-identity row, and
 * orders the rows so an arbitrary "first seat" pick would give the wrong
 * answer.
 */

const CONVERSATION_ID = 'c-mailbox';
const CUSTOMER_USER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const UNRESOLVED_IDENTITY_ID = 'identity-unresolved';

const STAFF_PROFILE = {
  userId: 'staff-1',
  slug: 'tiago-costa',
  firstName: 'Tiago',
  lastName: 'Costa',
  pronouns: 'he/him',
  photoVisible: true,
  avatarUrl: 'https://example.test/tiago.png',
};

const MAILBOX_DESCRIPTION = {
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
    identityId: MAILBOX_IDENTITY_ID,
    role: ConversationRole.Member,
    clearedAt: null,
    leftAt: null,
    removedAt: null,
    muted: false,
    mutedUntil: null,
    muteMode: 'all',
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

const customerSeat = (overrides: Partial<ConversationParticipant> = {}) =>
  seat({
    userId: CUSTOMER_USER_ID,
    identityId: CUSTOMER_IDENTITY_ID,
    ...overrides,
  });

interface QueryBuilderStandIn {
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  select: jest.Mock;
  innerJoin: jest.Mock;
  getRawAndEntities: jest.Mock;
  getRawMany: jest.Mock;
}

function makeQueryBuilder(): QueryBuilderStandIn {
  const queryBuilder = {} as QueryBuilderStandIn;
  const self = (): QueryBuilderStandIn => queryBuilder;
  queryBuilder.where = jest.fn(self);
  queryBuilder.andWhere = jest.fn(self);
  queryBuilder.setParameter = jest.fn(self);
  queryBuilder.addSelect = jest.fn(self);
  queryBuilder.orderBy = jest.fn(self);
  queryBuilder.addOrderBy = jest.fn(self);
  queryBuilder.take = jest.fn(self);
  queryBuilder.select = jest.fn(self);
  queryBuilder.innerJoin = jest.fn(self);
  queryBuilder.getRawAndEntities = jest
    .fn()
    .mockResolvedValue({ entities: [], raw: [] });
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
}

function buildService(options: {
  others: ConversationParticipant[];
  callerParticipant?: ConversationParticipant;
  lastMessage?: Record<string, unknown>;
  staffFirstNameForReader?: string | null;
  blockedUserIds?: string[];
  privacyByUser?: Map<string, { shareReadReceipts: boolean }>;
  acceptedSinceByCounterpart?: Map<string, Date>;
  claimedByUserId?: string | null;
  identityKinds?: { id: string; kind: IdentityKind }[];
  conversationKind?: ConversationKind;
  /** Task 14: `identity_blocks` rows, each `[blockerUserId, identityId]`. */
  identityBlockPairs?: Array<[string, string]>;
}) {
  const callerParticipant = options.callerParticipant ?? customerSeat();
  const conversation = {
    id: CONVERSATION_ID,
    kind: options.conversationKind ?? ConversationKind.Direct,
    isOfficial: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    title: null,
    avatarUrl: null,
    description: null,
    dissolvedAt: null,
    inviteToken: null,
    claimedByUserId: options.claimedByUserId ?? null,
    claimedAt: options.claimedByUserId
      ? new Date('2026-01-03T00:00:00.000Z')
      : null,
    initiatorUserId: CUSTOMER_USER_ID,
    openedAt: new Date('2026-01-01T01:00:00.000Z'),
  };
  const queryBuilder = makeQueryBuilder();
  const conversationsRepo = {
    find: jest.fn().mockResolvedValue([conversation]),
    findOne: jest.fn().mockResolvedValue(conversation),
  };
  const participantsRepo = {
    find: jest.fn().mockResolvedValue(options.others),
    // The pre-Task-13c live-room gate asked for "the other participant"
    // with an unordered `findOne`; it returns the first other seat, the
    // same arbitrary pick the fixtures order to be the wrong answer.
    findOne: jest.fn(({ where }: { where: { userId: unknown } }) =>
      Promise.resolve(
        typeof where.userId === 'string'
          ? callerParticipant
          : (options.others[0] ?? null),
      ),
    ),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const profilesRepo = {
    find: jest.fn().mockResolvedValue([STAFF_PROFILE]),
  };
  const identities = {
    getByIds: jest.fn().mockResolvedValue(
      options.identityKinds ?? [
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
      ],
    ),
    describeIdentities: jest
      .fn()
      .mockResolvedValue(new Map([[MAILBOX_IDENTITY_ID, MAILBOX_DESCRIPTION]])),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest.fn().mockResolvedValue({
      resolve: () => options.staffFirstNameForReader ?? null,
    }),
  };
  const lastMessages = new Map(
    options.lastMessage ? [[CONVERSATION_ID, options.lastMessage]] : [],
  );
  const core = {
    requireParticipant: jest.fn().mockResolvedValue(callerParticipant),
    lastMessagesByConversation: jest.fn().mockResolvedValue(lastMessages),
    unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
    reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
    hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
    // Task 14a: a group row's member roster, for the group-leaver guard.
    buildMemberPreview: jest.fn().mockReturnValue([]),
    buildMemberSummaries: jest.fn().mockReturnValue([]),
    groupCapabilities: jest.fn().mockReturnValue({}),
    // The real preview builder, so the inbox preview this suite asserts on
    // is the one a live response carries.
    buildLastMessagePreview: (
      ...previewArguments: Parameters<
        MessagingCoreService['buildLastMessagePreview']
      >
    ) =>
      MessagingCoreService.prototype.buildLastMessagePreview.call(
        {},
        ...previewArguments,
      ),
    // The real single-thread seat loader, reading the same stand-ins.
    loadDirectThreadSeats: (
      conversationId: string,
      caller: ConversationParticipant,
    ) =>
      MessagingCoreService.prototype.loadDirectThreadSeats.call(
        { participants: participantsRepo, identities },
        conversationId,
        caller,
      ),
  };
  const blockedUserIds = new Set(options.blockedUserIds ?? []);
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(blockedUserIds),
    isBlockedEitherWay: jest.fn((_userId: string, otherUserId: string) =>
      Promise.resolve(blockedUserIds.has(otherUserId)),
    ),
    identityBlocksAmong: jest.fn(
      (blockerUserIds: string[], blockedIdentityIds: string[]) =>
        Promise.resolve(
          (options.identityBlockPairs ?? [])
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
  };
  const connectionsService = {
    allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    acceptedSinceByCounterpart: jest
      .fn()
      .mockResolvedValue(options.acceptedSinceByCounterpart ?? new Map()),
  };
  const preferencesService = {
    getMessagingPrivacyForUsers: jest
      .fn()
      .mockResolvedValue(options.privacyByUser ?? new Map()),
  };
  const service = new ConversationsService(
    conversationsRepo as never,
    participantsRepo as never,
    profilesRepo as never,
    core as never,
    blockFilter as never,
    { emit: jest.fn() } as never,
    {} as never,
    { getMany: jest.fn().mockResolvedValue(new Map()) } as never,
    connectionsService as never,
    preferencesService as never,
    identities as never,
    identityAttribution as never,
  );
  return { service, queryBuilder };
}

/** A message the staff member typed and sent AS the listing mailbox. */
const BUSINESS_REPLY = {
  id: 'm-last',
  conversationId: CONVERSATION_ID,
  senderId: STAFF_PROFILE.userId,
  senderIdentityId: MAILBOX_IDENTITY_ID,
  body: 'Your table is ready',
  createdAt: new Date('2026-01-02T12:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
  clientMessageId: null,
  forwarded: false,
  kind: MessageKind.User,
  systemEvent: null,
  attachment: null,
};

function expectNoStaffTrace(serialized: string) {
  expect(serialized).not.toContain('Costa');
  expect(serialized).not.toContain('tiago-costa');
  expect(serialized).not.toContain('tiago.png');
  expect(serialized).not.toContain('he/him');
}

describe('Task 13c: the inbox preview of a business reply', () => {
  it("names the business, and carries none of the staff member's name, handle, pronouns or avatar anywhere in the customer's summary", async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
      lastMessage: BUSINESS_REPLY,
      staffFirstNameForReader: null,
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.lastMessage?.sender.displayName).toBe('Cafe Lisboa');
    expect(result.lastMessage?.sender.handle).toBe('cafe-lisboa');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Tiago');
    expectNoStaffTrace(serialized);
  });

  it('carries the staff first name on the preview only when attribution allows it, and nothing else of theirs', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' })],
      lastMessage: BUSINESS_REPLY,
      staffFirstNameForReader: 'Tiago',
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.lastMessage?.sender.displayName).toBe('Cafe Lisboa');
    expect(result.lastMessage?.sender.staffFirstName).toBe('Tiago');
    expectNoStaffTrace(JSON.stringify(result));
  });
});

describe('Task 13c: the header of a business thread', () => {
  it('names no staff member for a customer, even with attribution on and a staff member who has not declined', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
      staffFirstNameForReader: 'Tiago',
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherParticipant?.displayName).toBe('Cafe Lisboa');
    expect(result.otherParticipant?.staffFirstName).toBeUndefined();
    expect(JSON.stringify(result.otherParticipant)).not.toContain('Tiago');
  });
});

describe("Task 13c: the customer's read gate", () => {
  const optedIn = seat({
    userId: 'staff-1',
    lastReadAt: new Date('2026-01-02T10:00:00.000Z'),
    lastReadInstant: new Date('2026-01-02T10:00:05.000Z'),
  });
  // Read LATER than the opted-in colleague, so a collapse that let this seat
  // contribute would show its time.
  const optedOut = seat({
    userId: 'staff-2',
    lastReadAt: new Date('2026-01-02T12:00:00.000Z'),
    lastReadInstant: new Date('2026-01-02T12:00:05.000Z'),
  });
  const privacyByUser = new Map([
    ['staff-1', { shareReadReceipts: true }],
    ['staff-2', { shareReadReceipts: false }],
  ]);

  it.each([
    ['opted-in seat first', [optedIn, optedOut]],
    ['opted-out seat first', [optedOut, optedIn]],
  ])(
    "shows only the opted-in staff member's read time (%s)",
    async (_order, others) => {
      const { service } = buildService({ others, privacyByUser });

      const result = await service.getConversation(
        CONVERSATION_ID,
        CUSTOMER_USER_ID,
      );

      expect(result.otherLastReadAt).toBe('2026-01-02T10:00:00.000Z');
      expect(result.otherLastReadInstant).toBe('2026-01-02T10:00:05.000Z');
    },
  );

  it('shows no read time when the only staff member who shares read receipts has not read, even though an opted-out colleague has', async () => {
    const optedInUnread = seat({ userId: 'staff-1' });
    const { service } = buildService({
      others: [optedInUnread, optedOut],
      privacyByUser,
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherLastReadAt).toBeNull();
    expect(result.otherLastReadInstant).toBeNull();
  });
});

describe('Task 13c: person-to-person blocks on a business thread', () => {
  it('keeps the business thread visible to a customer who personally blocked one staff member', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
      blockedUserIds: ['staff-1'],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.id).toBe(CONVERSATION_ID);
    expect(result.otherParticipant?.displayName).toBe('Cafe Lisboa');
  });

  it('keeps the shared mailbox thread visible to a staff member who blocked a colleague', async () => {
    const { service } = buildService({
      callerParticipant: seat({ userId: 'staff-1' }),
      others: [seat({ userId: 'staff-2' }), customerSeat()],
      blockedUserIds: ['staff-2'],
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.id).toBe(CONVERSATION_ID);
    expect(result.otherParticipantId).toBe(CUSTOMER_USER_ID);
  });

  // Regression guard, unchanged behaviour: the mailbox exemption above must
  // stay scoped to mailbox threads.
  it('still drops an ordinary DM with a blocked member', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'member-2', identityId: 'identity-member-2' })],
      identityKinds: [
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: 'identity-member-2', kind: IdentityKind.Profile },
      ],
      blockedUserIds: ['member-2'],
    });

    await expect(
      service.getConversation(CONVERSATION_ID, CUSTOMER_USER_ID),
    ).rejects.toThrow('Conversation not found');
  });

  it("exempts a mailbox thread from the inbox list's SQL block pre-filter", async () => {
    const { service, queryBuilder } = buildService({ others: [] });

    await service.listConversations(CUSTOMER_USER_ID, {});

    const blockClauses = (queryBuilder.andWhere.mock.calls as [string][])
      .map(([sql]) => sql)
      .filter((sql) => sql.includes('FROM blocks block'));
    expect(blockClauses).toHaveLength(1);
    expect(blockClauses[0]).toContain('AND NOT EXISTS (');
    expect(blockClauses[0]).toContain(`"mailbox_identity"."kind" <> 'profile'`);
  });

  it('lets a customer who personally blocked one staff member join the business thread live', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
      blockedUserIds: ['staff-1'],
    });

    await expect(
      service.canJoinConversationLive(CONVERSATION_ID, CUSTOMER_USER_ID),
    ).resolves.toBe(true);
  });

  // Regression guard, unchanged behaviour, as above.
  it('keeps an ordinary DM with a blocked member closed to a live join', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'member-2', identityId: 'identity-member-2' })],
      identityKinds: [
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: 'identity-member-2', kind: IdentityKind.Profile },
      ],
      blockedUserIds: ['member-2'],
    });

    await expect(
      service.canJoinConversationLive(CONVERSATION_ID, CUSTOMER_USER_ID),
    ).resolves.toBe(false);
  });

  it('leaves mailbox threads out of the rooms a personal block evicts from and the threads whose opened state it voids', async () => {
    const { service, queryBuilder } = buildService({ others: [] });

    await service.directConversationIdsBetween(CUSTOMER_USER_ID, 'staff-1');

    const clauses = (queryBuilder.andWhere.mock.calls as [string][]).map(
      ([sql]) => sql,
    );
    expect(
      clauses.some(
        (sql) =>
          sql.startsWith('NOT EXISTS (') &&
          sql.includes(`"mailbox_identity"."kind" <> 'profile'`),
      ),
    ).toBe(true);
  });
});

describe('Task 13c fix round 1: a personal block takes the blocked staff member out of the thread', () => {
  // The customer and staff-1 are blocked (either direction; `blockedUserIds`
  // is the caller's "blocked either way" set). staff-2 is an unblocked
  // colleague.
  it('drops the thread from the inbox of a staff member blocked with the customer', async () => {
    const { service } = buildService({
      callerParticipant: seat({ userId: 'staff-1' }),
      others: [seat({ userId: 'staff-2' }), customerSeat()],
      blockedUserIds: [CUSTOMER_USER_ID],
    });

    await expect(
      service.getConversation(CONVERSATION_ID, 'staff-1'),
    ).rejects.toThrow('Conversation not found');
  });

  it("leaves the blocked staff member out of the inbox list's SQL", async () => {
    const { service, queryBuilder } = buildService({ others: [] });

    await service.listConversations('staff-1', {});

    const exclusionClauses = (queryBuilder.andWhere.mock.calls as [string][])
      .map(([sql]) => sql)
      .filter((sql) => sql.includes('"blocked_staff_seat"'));
    expect(exclusionClauses).toHaveLength(1);
    expect(exclusionClauses[0]!.startsWith('NOT ((EXISTS (')).toBe(true);
    expect(exclusionClauses[0]).toContain(
      `"blocked_staff_identity"."kind" <> 'profile'`,
    );
  });

  it('refuses the blocked staff member a live join', async () => {
    const { service } = buildService({
      callerParticipant: seat({ userId: 'staff-1' }),
      others: [seat({ userId: 'staff-2' }), customerSeat()],
      blockedUserIds: [CUSTOMER_USER_ID],
    });

    await expect(
      service.canJoinConversationLive(CONVERSATION_ID, 'staff-1'),
    ).resolves.toBe(false);
  });

  // Regression guard: the exclusion is keyed on a block with the CUSTOMER.
  // staff-2 has blocked the colleague staff-1, which changes nothing.
  it('keeps the thread, and the live join, for a colleague of the blocked staff member, even one who blocked that colleague', async () => {
    const { service } = buildService({
      callerParticipant: seat({ userId: 'staff-2' }),
      others: [seat({ userId: 'staff-1' }), customerSeat()],
      blockedUserIds: ['staff-1'],
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-2');

    expect(result.otherParticipantId).toBe(CUSTOMER_USER_ID);
    await expect(
      service.canJoinConversationLive(CONVERSATION_ID, 'staff-2'),
    ).resolves.toBe(true);
  });

  // Regression guard: the customer's view is the same as without a block.
  it('shows the customer the same business thread whether or not they blocked a staff member', async () => {
    const others = [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })];
    const withBlock = await buildService({
      others,
      blockedUserIds: ['staff-1'],
    }).service.getConversation(CONVERSATION_ID, CUSTOMER_USER_ID);
    const withoutBlock = await buildService({ others }).service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(withBlock).toEqual(withoutBlock);
  });
});

describe('Task 13c fix round 1: claimedAt is staff information', () => {
  it('hides claimedAt from the customer', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' })],
      claimedByUserId: 'staff-1',
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.claimedAt).toBeNull();
  });

  // Regression guard: staff keep the timestamp.
  it('keeps claimedAt for a staff member of the mailbox', async () => {
    const { service } = buildService({
      callerParticipant: seat({ userId: 'staff-2' }),
      others: [seat({ userId: 'staff-1' }), customerSeat()],
      claimedByUserId: 'staff-1',
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-2');

    expect(result.claimedAt).toBe('2026-01-03T00:00:00.000Z');
  });
});

describe('Task 13c fix round 1: the preview of a deleted business', () => {
  it('previews a message sent as an identity that no longer resolves as the former-business placeholder, with no trace of the human', async () => {
    const { service } = buildService({
      others: [seat({ userId: 'staff-1' })],
      lastMessage: { ...BUSINESS_REPLY, senderIdentityId: 'identity-deleted' },
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.lastMessage?.sender.isFormerIdentity).toBe(true);
    expect(result.lastMessage?.sender.displayName).toBe('Former business');
    expect(JSON.stringify(result.lastMessage)).not.toContain('Tiago');
  });
});

describe('Task 13c: seats whose identities do not resolve fail closed', () => {
  it('names no single human when the caller and a colleague share an identity that did not resolve', async () => {
    // A staff caller whose own mailbox identity (shared with the colleague
    // ordered first) did not resolve. The customer's profile identity did.
    const { service } = buildService({
      callerParticipant: seat({
        userId: 'staff-1',
        identityId: UNRESOLVED_IDENTITY_ID,
      }),
      others: [
        seat({
          userId: 'staff-2',
          identityId: UNRESOLVED_IDENTITY_ID,
          lastReadAt: new Date('2026-01-02T10:00:00.000Z'),
          lastReadInstant: new Date('2026-01-02T10:00:05.000Z'),
          deliveredAt: new Date('2026-01-02T10:00:00.000Z'),
        }),
        customerSeat(),
      ],
      identityKinds: [{ id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile }],
      acceptedSinceByCounterpart: new Map([
        ['staff-2', new Date('2025-06-01T00:00:00.000Z')],
      ]),
      claimedByUserId: 'staff-2',
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherParticipantId).toBeNull();
    expect(result.otherDeliveredAt).toBeNull();
    expect(result.otherLastReadAt).toBeNull();
    expect(result.otherLastReadInstant).toBeNull();
    expect(result.connectedSince).toBeNull();
    expect(result.claimedBy).toBeNull();
    expect(JSON.stringify(result)).not.toContain('staff-2');
  });
});

describe('Task 14a: a staff member who left the business', () => {
  const LEFT_AT = new Date('2026-01-02T00:00:00.000Z');

  function inboxOf(
    callerParticipant: ConversationParticipant,
    others: ConversationParticipant[],
    extraOptions: Partial<Parameters<typeof buildService>[0]> = {},
  ) {
    const built = buildService({ callerParticipant, others, ...extraOptions });
    built.queryBuilder.getRawAndEntities.mockResolvedValue({
      entities: [callerParticipant],
      raw: [],
    });
    return built;
  }

  it("drops the mailbox thread from the departed staff member's inbox and from getConversation", async () => {
    const { service } = inboxOf(seat({ userId: 'staff-1', leftAt: LEFT_AT }), [
      seat({ userId: 'staff-2' }),
      customerSeat(),
    ]);

    await expect(service.listConversations('staff-1')).resolves.toEqual([]);
    await expect(
      service.getConversation(CONVERSATION_ID, 'staff-1'),
    ).rejects.toThrow('Conversation not found');
  });

  it("keeps the thread in a live colleague's inbox", async () => {
    const { service } = inboxOf(seat({ userId: 'staff-2' }), [
      seat({ userId: 'staff-1', leftAt: LEFT_AT }),
      customerSeat(),
    ]);

    const inbox = await service.listConversations('staff-2');

    expect(inbox.map((row) => row.id)).toEqual([CONVERSATION_ID]);
  });

  it('keeps a group in the inbox of a member who left it (regression guard, unchanged behaviour)', async () => {
    const { service } = inboxOf(
      seat({
        userId: 'member-1',
        identityId: 'identity-member-1',
        leftAt: LEFT_AT,
      }),
      [seat({ userId: 'member-2', identityId: 'identity-member-2' })],
      {
        conversationKind: ConversationKind.Group,
        identityKinds: [
          { id: 'identity-member-1', kind: IdentityKind.Profile },
          { id: 'identity-member-2', kind: IdentityKind.Profile },
        ],
      },
    );

    const inbox = await service.listConversations('member-1');

    expect(inbox.map((row) => row.id)).toEqual([CONVERSATION_ID]);
  });

  it('gives the thread back once the staff member is seated again', async () => {
    const { service } = inboxOf(seat({ userId: 'staff-1', leftAt: null }), [
      seat({ userId: 'staff-2' }),
      customerSeat(),
    ]);

    const inbox = await service.listConversations('staff-1');

    expect(inbox.map((row) => row.id)).toEqual([CONVERSATION_ID]);
    await expect(
      service.canJoinConversationLive(CONVERSATION_ID, 'staff-1'),
    ).resolves.toBe(true);
  });

  it("carries the shared exclusion rule, block and departure together, in the inbox list's SQL", async () => {
    const { service, queryBuilder } = buildService({ others: [] });

    await service.listConversations('staff-1', {});

    expect(
      (queryBuilder.andWhere.mock.calls as [string][]).map(([sql]) => sql),
    ).toContain(
      `NOT ${seatExcludedFromMailboxPredicate('participant.conversation_id', ':userId')}`,
    );
  });

  // Regression guard: the live join already refused any seat with `leftAt`
  // before this task. It now reaches the same answer through
  // `isSeatExcludedFromMailbox`, and the colleague still joins.
  it('refuses the departed staff member a live join, and lets the colleague in', async () => {
    const departed = buildService({
      callerParticipant: seat({ userId: 'staff-1', leftAt: LEFT_AT }),
      others: [seat({ userId: 'staff-2' }), customerSeat()],
    });
    const colleague = buildService({
      callerParticipant: seat({ userId: 'staff-2' }),
      others: [seat({ userId: 'staff-1', leftAt: LEFT_AT }), customerSeat()],
    });

    await expect(
      departed.service.canJoinConversationLive(CONVERSATION_ID, 'staff-1'),
    ).resolves.toBe(false);
    await expect(
      colleague.service.canJoinConversationLive(CONVERSATION_ID, 'staff-2'),
    ).resolves.toBe(true);
  });
});

describe('Task 14: a customer who blocked the business as a whole', () => {
  const OTHER_MAILBOX_IDENTITY_ID = 'identity-other-mailbox';
  const OWNER_USER_ID = 'staff-1';
  const blockOfThisBusiness: Array<[string, string]> = [
    [CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID],
  ];

  function inboxOf(
    callerParticipant: ConversationParticipant,
    others: ConversationParticipant[],
    extraOptions: Partial<Parameters<typeof buildService>[0]> = {},
  ) {
    const built = buildService({ callerParticipant, others, ...extraOptions });
    built.queryBuilder.getRawAndEntities.mockResolvedValue({
      entities: [callerParticipant],
      raw: [],
    });
    return built;
  }

  it("drops the business's thread from the customer's inbox", async () => {
    const { service } = inboxOf(
      customerSeat(),
      [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
      { identityBlockPairs: blockOfThisBusiness },
    );

    await expect(service.listConversations(CUSTOMER_USER_ID)).resolves.toEqual(
      [],
    );
  });

  it("drops the thread from every staff member's inbox too", async () => {
    const { service } = inboxOf(
      seat({ userId: 'staff-2' }),
      [seat({ userId: 'staff-1' }), customerSeat()],
      { identityBlockPairs: blockOfThisBusiness },
    );

    await expect(service.listConversations('staff-2')).resolves.toEqual([]);
  });

  it('keeps a thread with another business that the same staff member works for, while the blocked business drops out', async () => {
    const blockedBusiness = inboxOf(
      customerSeat(),
      [seat({ userId: OWNER_USER_ID }), seat({ userId: 'staff-2' })],
      { identityBlockPairs: blockOfThisBusiness },
    );
    const { service } = inboxOf(
      customerSeat(),
      [
        seat({ userId: OWNER_USER_ID, identityId: OTHER_MAILBOX_IDENTITY_ID }),
        seat({ userId: 'staff-3', identityId: OTHER_MAILBOX_IDENTITY_ID }),
      ],
      {
        identityBlockPairs: blockOfThisBusiness,
        identityKinds: [
          { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
          { id: OTHER_MAILBOX_IDENTITY_ID, kind: IdentityKind.Company },
        ],
      },
    );

    const inbox = await service.listConversations(CUSTOMER_USER_ID);

    expect(inbox.map((row) => row.id)).toEqual([CONVERSATION_ID]);
    await expect(
      blockedBusiness.service.listConversations(CUSTOMER_USER_ID),
    ).resolves.toEqual([]);
  });

  it("keeps the business's thread for a customer who blocked its owner as a person only, and drops it once they block the business", async () => {
    const staffSeats = [
      seat({ userId: OWNER_USER_ID }),
      seat({ userId: 'staff-2' }),
    ];
    const personBlockOnly = inboxOf(customerSeat(), staffSeats, {
      blockedUserIds: [OWNER_USER_ID],
    });
    const businessBlockToo = inboxOf(customerSeat(), staffSeats, {
      blockedUserIds: [OWNER_USER_ID],
      identityBlockPairs: blockOfThisBusiness,
    });

    const inbox =
      await personBlockOnly.service.listConversations(CUSTOMER_USER_ID);

    expect(inbox.map((row) => row.id)).toEqual([CONVERSATION_ID]);
    await expect(
      businessBlockToo.service.listConversations(CUSTOMER_USER_ID),
    ).resolves.toEqual([]);
  });

  it('refuses the live join to the customer and to a staff member, and admits both after the unblock', async () => {
    const others = [seat({ userId: 'staff-2' }), customerSeat()];
    const customerDuringBlock = buildService({
      others: [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
      identityBlockPairs: blockOfThisBusiness,
    });
    const staffDuringBlock = buildService({
      callerParticipant: seat({ userId: 'staff-1' }),
      others,
      identityBlockPairs: blockOfThisBusiness,
    });
    const customerAfterUnblock = buildService({
      others: [seat({ userId: 'staff-1' }), seat({ userId: 'staff-2' })],
    });
    const staffAfterUnblock = buildService({
      callerParticipant: seat({ userId: 'staff-1' }),
      others,
    });

    await expect(
      customerDuringBlock.service.canJoinConversationLive(
        CONVERSATION_ID,
        CUSTOMER_USER_ID,
      ),
    ).resolves.toBe(false);
    await expect(
      staffDuringBlock.service.canJoinConversationLive(
        CONVERSATION_ID,
        'staff-1',
      ),
    ).resolves.toBe(false);
    await expect(
      customerAfterUnblock.service.canJoinConversationLive(
        CONVERSATION_ID,
        CUSTOMER_USER_ID,
      ),
    ).resolves.toBe(true);
    await expect(
      staffAfterUnblock.service.canJoinConversationLive(
        CONVERSATION_ID,
        'staff-1',
      ),
    ).resolves.toBe(true);
  });
});
