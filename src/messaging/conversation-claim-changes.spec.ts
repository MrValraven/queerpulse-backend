import { IdentityKind } from '../identities/entities/identity.entity';
import {
  CONVERSATION_CLAIM_CHANGED,
  ConversationClaimChangedEvent,
  returnedTimestamp,
} from './conversation-claim';
import { ConversationsService } from './conversations.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 19: claims name people, record releases, and take over atomically.
 *
 * The write tests run `claim`, `takeOver` and `release` against a stand-in
 * for the conversation row that applies each conditional UPDATE the way
 * Postgres would: the `set` lands only when the guard in `andWhere` matches
 * the row as it stands at write time, and `affected` says whether it did.
 * `beforeWrite` changes the row between the service's read and its write,
 * to play a colleague who got there first.
 */

const CONVERSATION_ID = 'conversation-1';
const CUSTOMER_USER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const WRITE_INSTANT = new Date('2026-03-01T09:00:00.000Z');
const EARLIER_INSTANT = new Date('2026-02-01T09:00:00.000Z');

interface ClaimRow {
  id: string;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  claimReleasedByUserId: string | null;
  claimReleasedAt: Date | null;
  claimTakenOverFromUserId: string | null;
}

function claimRow(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: CONVERSATION_ID,
    claimedByUserId: null,
    claimedAt: null,
    claimReleasedByUserId: null,
    claimReleasedAt: null,
    claimTakenOverFromUserId: null,
    ...overrides,
  };
}

function profileOf(userId: string) {
  return {
    userId,
    slug: `${userId}-handle`,
    firstName: userId,
    lastName: 'Staff',
    pronouns: null,
    photoVisible: false,
    avatarUrl: null,
  };
}

/** The column a `ClaimRow` property is stored in, for `RETURNING` rows. */
const COLUMN_BY_PROPERTY: Record<string, string> = {
  claimedAt: 'claimed_at',
  claimReleasedAt: 'claim_released_at',
};

/**
 * A `ConversationsService` whose conversation repository is a stateful
 * stand-in for one row. Every UPDATE it runs is recorded in `writes`, with
 * whether it matched.
 */
function makeWriteHarness(
  initialRow: ClaimRow,
  options: { beforeWrite?: (row: ClaimRow) => void } = {},
) {
  let row = { ...initialRow };
  const writes: Array<{
    set: Record<string, unknown>;
    guard: string;
    isMatched: boolean;
  }> = [];

  const createQueryBuilder = () => {
    let pendingSet: Record<string, unknown> = {};
    let guard = '';
    let guardParameters: Record<string, unknown> = {};
    let returningProperties: string[] = [];
    const builder = {
      update: () => builder,
      set: (values: Record<string, unknown>) => {
        pendingSet = values;
        return builder;
      },
      where: () => builder,
      andWhere: (
        condition: string,
        parameters: Record<string, unknown> = {},
      ) => {
        guard = condition;
        guardParameters = parameters;
        return builder;
      },
      returning: (properties: string[]) => {
        returningProperties = properties;
        return builder;
      },
      execute: () => {
        options.beforeWrite?.(row);
        const isMatched = guard.endsWith('IS NULL')
          ? row.claimedByUserId === null
          : row.claimedByUserId === Object.values(guardParameters)[0];
        writes.push({ set: pendingSet, guard, isMatched });
        if (!isMatched) {
          return Promise.resolve({ affected: 0, raw: [] });
        }
        const applied = Object.fromEntries(
          Object.entries(pendingSet).map(([property, value]) => [
            property,
            typeof value === 'function' ? WRITE_INSTANT : value,
          ]),
        );
        row = { ...row, ...applied };
        const returnedRow = Object.fromEntries(
          returningProperties.map((property) => [
            COLUMN_BY_PROPERTY[property] ?? property,
            row[property as keyof ClaimRow],
          ]),
        );
        return Promise.resolve({ affected: 1, raw: [returnedRow] });
      },
    };
    return builder;
  };

  const service = Object.create(
    ConversationsService.prototype,
  ) as ConversationsService;
  const eventEmitter = { emit: jest.fn() };
  const conversations = {
    createQueryBuilder: jest.fn(createQueryBuilder),
    findOne: jest.fn(() => Promise.resolve({ ...row })),
  };
  Object.assign(service, {
    core: {
      requireParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
      }),
    },
    conversations,
    participants: {
      find: jest
        .fn()
        .mockResolvedValue([
          { identityId: CUSTOMER_IDENTITY_ID },
          { identityId: MAILBOX_IDENTITY_ID },
        ]),
    },
    identities: {
      getById: jest.fn((identityId: string) =>
        Promise.resolve({
          id: identityId,
          kind:
            identityId === MAILBOX_IDENTITY_ID
              ? IdentityKind.Listing
              : IdentityKind.Profile,
        }),
      ),
      assertMayActAs: jest.fn().mockResolvedValue(undefined),
    },
    profiles: {
      find: jest.fn(({ where }: { where: { userId: { value: string[] } } }) =>
        Promise.resolve(where.userId.value.map(profileOf)),
      ),
    },
    eventEmitter,
  });
  return {
    service,
    eventEmitter,
    conversations,
    writes,
    currentRow: () => row,
  };
}

function emittedClaimEvents(eventEmitter: {
  emit: jest.Mock;
}): ConversationClaimChangedEvent[] {
  return eventEmitter.emit.mock.calls
    .filter(([eventName]) => eventName === CONVERSATION_CLAIM_CHANGED)
    .map(([, event]) => event as ConversationClaimChangedEvent);
}

describe('Task 19: release records who released', () => {
  it('records the releaser and the instant, and clears the take-over column in the same UPDATE', async () => {
    const harness = makeWriteHarness(
      claimRow({
        claimedByUserId: 'ana',
        claimedAt: EARLIER_INSTANT,
        claimTakenOverFromUserId: 'rui',
      }),
    );

    await harness.service.release(CONVERSATION_ID, 'maria');

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]!.set).toEqual({
      claimedByUserId: null,
      claimedAt: null,
      claimReleasedByUserId: 'maria',
      claimReleasedAt: expect.any(Function),
      claimTakenOverFromUserId: null,
    });
    expect(harness.writes[0]!.guard).toContain('claimed_by_user_id = :');
    expect(harness.currentRow()).toEqual(
      claimRow({
        claimReleasedByUserId: 'maria',
        claimReleasedAt: WRITE_INSTANT,
      }),
    );
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([
      {
        conversationId: CONVERSATION_ID,
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
        change: 'released',
        isImplicit: false,
        actorUserId: 'maria',
        claimedByUserId: null,
        previousClaimantUserId: 'ana',
        changedAt: WRITE_INSTANT,
      },
    ]);
  });

  it('writes once and leaves a take-over that landed between its read and its write standing', async () => {
    // Rui takes over from Ana after the release read Ana as the claimant.
    const harness = makeWriteHarness(
      claimRow({ claimedByUserId: 'ana', claimedAt: EARLIER_INSTANT }),
      {
        beforeWrite: (row) => {
          row.claimedByUserId = 'rui';
          row.claimedAt = WRITE_INSTANT;
          row.claimTakenOverFromUserId = 'ana';
        },
      },
    );

    const response = await harness.service.release(CONVERSATION_ID, 'maria');

    // Exactly one write, and no second one after the re-read.
    expect(harness.writes.map((write) => write.isMatched)).toEqual([false]);
    expect(harness.currentRow()).toEqual(
      claimRow({
        claimedByUserId: 'rui',
        claimedAt: WRITE_INSTANT,
        claimTakenOverFromUserId: 'ana',
      }),
    );
    expect(response).toEqual({
      claimedByUserId: 'rui',
      isNewlyClaimed: false,
      claimedBy: expect.objectContaining({ handle: 'rui-handle' }),
      claimedAt: WRITE_INSTANT.toISOString(),
      isReleased: false,
    });
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });

  it('answers a release that changed the row with the thread unclaimed', async () => {
    const harness = makeWriteHarness(claimRow({ claimedByUserId: 'ana' }));

    await expect(
      harness.service.release(CONVERSATION_ID, 'maria'),
    ).resolves.toEqual({
      claimedByUserId: null,
      isNewlyClaimed: false,
      claimedBy: null,
      claimedAt: null,
      isReleased: true,
    });
  });
});

describe('Task 19: a claim after a release', () => {
  it('clears both release columns and the take-over column', async () => {
    const harness = makeWriteHarness(
      claimRow({
        claimReleasedByUserId: 'maria',
        claimReleasedAt: EARLIER_INSTANT,
      }),
    );

    const response = await harness.service.claim(CONVERSATION_ID, 'rui');

    expect(harness.writes[0]!.set).toEqual({
      claimedByUserId: 'rui',
      claimedAt: expect.any(Function),
      claimReleasedByUserId: null,
      claimReleasedAt: null,
      claimTakenOverFromUserId: null,
    });
    expect(harness.currentRow()).toEqual(
      claimRow({ claimedByUserId: 'rui', claimedAt: WRITE_INSTANT }),
    );
    expect(response).toEqual({
      claimedByUserId: 'rui',
      isNewlyClaimed: true,
      claimedBy: expect.objectContaining({ handle: 'rui-handle' }),
      claimedAt: WRITE_INSTANT.toISOString(),
    });
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([
      expect.objectContaining({
        change: 'claimed',
        isImplicit: false,
        actorUserId: 'rui',
        claimedByUserId: 'rui',
        previousClaimantUserId: null,
        changedAt: WRITE_INSTANT,
      }),
    ]);
  });
});

describe('Task 19: take-over', () => {
  it('takes the thread from the claimant the caller named, and records whose claim it was', async () => {
    const harness = makeWriteHarness(
      claimRow({ claimedByUserId: 'ana', claimedAt: EARLIER_INSTANT }),
    );

    const response = await harness.service.takeOver(
      CONVERSATION_ID,
      'rui',
      'ana',
    );

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]!.guard).toBe('claimed_by_user_id = :fromUserId');
    expect(harness.currentRow()).toEqual(
      claimRow({
        claimedByUserId: 'rui',
        claimedAt: WRITE_INSTANT,
        claimTakenOverFromUserId: 'ana',
      }),
    );
    expect(response).toEqual({
      claimedByUserId: 'rui',
      isNewlyClaimed: true,
      claimedBy: expect.objectContaining({ handle: 'rui-handle' }),
      claimedAt: WRITE_INSTANT.toISOString(),
      previousClaimant: expect.objectContaining({ handle: 'ana-handle' }),
    });
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([
      {
        conversationId: CONVERSATION_ID,
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
        change: 'taken_over',
        isImplicit: false,
        actorUserId: 'rui',
        claimedByUserId: 'rui',
        previousClaimantUserId: 'ana',
        changedAt: WRITE_INSTANT,
      },
    ]);
  });

  it('changes nothing when the named claimant no longer holds it, and reads the current state', async () => {
    const initialRow = claimRow({
      claimedByUserId: 'maria',
      claimedAt: EARLIER_INSTANT,
    });
    const harness = makeWriteHarness(initialRow);

    const response = await harness.service.takeOver(
      CONVERSATION_ID,
      'rui',
      'ana',
    );

    expect(harness.writes.map((write) => write.isMatched)).toEqual([false]);
    expect(harness.currentRow()).toEqual(initialRow);
    expect(response).toEqual({
      claimedByUserId: 'maria',
      isNewlyClaimed: false,
      claimedBy: expect.objectContaining({ handle: 'maria-handle' }),
      claimedAt: EARLIER_INSTANT.toISOString(),
      previousClaimant: null,
    });
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });

  it('changes nothing when the thread was released before the take-over landed', async () => {
    const harness = makeWriteHarness(
      claimRow({
        claimReleasedByUserId: 'ana',
        claimReleasedAt: EARLIER_INSTANT,
      }),
    );

    const response = await harness.service.takeOver(
      CONVERSATION_ID,
      'rui',
      'ana',
    );

    expect(harness.currentRow().claimedByUserId).toBeNull();
    expect(response).toEqual({
      claimedByUserId: null,
      isNewlyClaimed: false,
      claimedBy: null,
      claimedAt: null,
      previousClaimant: null,
    });
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });

  it('reads the current state unchanged when the caller names themselves', async () => {
    const initialRow = claimRow({
      claimedByUserId: 'rui',
      claimedAt: EARLIER_INSTANT,
    });
    const harness = makeWriteHarness(initialRow);

    const response = await harness.service.takeOver(
      CONVERSATION_ID,
      'rui',
      'rui',
    );

    expect(harness.writes).toEqual([]);
    expect(harness.currentRow()).toEqual(initialRow);
    expect(response).toEqual(
      expect.objectContaining({
        claimedByUserId: 'rui',
        isNewlyClaimed: false,
        previousClaimant: null,
      }),
    );
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });
});

describe('Task 19: a lost claim names the winner', () => {
  it("returns the winner's author summary", async () => {
    const harness = makeWriteHarness(
      claimRow({ claimedByUserId: 'ana', claimedAt: EARLIER_INSTANT }),
    );

    const response = await harness.service.claim(CONVERSATION_ID, 'rui');

    expect(response).toEqual({
      claimedByUserId: 'ana',
      isNewlyClaimed: false,
      claimedBy: expect.objectContaining({
        handle: 'ana-handle',
        displayName: 'ana Staff',
      }),
      claimedAt: EARLIER_INSTANT.toISOString(),
    });
  });

  it('names nobody when the re-read finds the thread released in between', async () => {
    // Ana held it when the UPDATE ran, and released it before the re-read.
    const harness = makeWriteHarness(
      claimRow({ claimedByUserId: 'ana', claimedAt: EARLIER_INSTANT }),
    );
    harness.conversations.findOne.mockResolvedValueOnce(
      claimRow({
        claimReleasedByUserId: 'ana',
        claimReleasedAt: WRITE_INSTANT,
      }),
    );

    const response = await harness.service.claim(CONVERSATION_ID, 'rui');

    expect(harness.writes.map((write) => write.isMatched)).toEqual([false]);
    expect(response).toEqual({
      claimedByUserId: null,
      isNewlyClaimed: false,
      claimedBy: null,
      claimedAt: null,
    });
  });
});

describe('Task 19: nothing emits when nothing changed', () => {
  it('emits nothing for the release of an unclaimed thread', async () => {
    const harness = makeWriteHarness(claimRow());
    await harness.service.release(CONVERSATION_ID, 'maria');
    expect(harness.writes).toEqual([]);
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });

  it('emits nothing for a claim the caller already holds', async () => {
    const harness = makeWriteHarness(
      claimRow({ claimedByUserId: 'rui', claimedAt: EARLIER_INSTANT }),
    );
    const response = await harness.service.claim(CONVERSATION_ID, 'rui');
    expect(response.isNewlyClaimed).toBe(true);
    expect(harness.writes.map((write) => write.isMatched)).toEqual([false]);
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });

  it('emits nothing for a take-over that matched no row', async () => {
    const harness = makeWriteHarness(
      claimRow({ claimedByUserId: 'maria', claimedAt: EARLIER_INSTANT }),
    );
    await harness.service.takeOver(CONVERSATION_ID, 'rui', 'ana');
    expect(emittedClaimEvents(harness.eventEmitter)).toEqual([]);
  });

  it('keeps the write when a listener throws', async () => {
    const harness = makeWriteHarness(claimRow());
    harness.eventEmitter.emit.mockImplementation(() => {
      throw new Error('relay down');
    });
    await expect(
      harness.service.claim(CONVERSATION_ID, 'rui'),
    ).resolves.toEqual(expect.objectContaining({ isNewlyClaimed: true }));
    expect(harness.currentRow().claimedByUserId).toBe('rui');
  });
});

// ---------------------------------------------------------------------------
// The conversation read (test 5).
// ---------------------------------------------------------------------------

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

const customerSeat = () =>
  seat({ userId: CUSTOMER_USER_ID, identityId: CUSTOMER_IDENTITY_ID });

/** The claim columns a read fixture's conversation row carries. */
type ReadClaimState = Pick<
  ClaimRow,
  | 'claimedByUserId'
  | 'claimedAt'
  | 'claimReleasedByUserId'
  | 'claimReleasedAt'
  | 'claimTakenOverFromUserId'
>;

// All three claim-change columns set at once, so each field's staff-only
// rule is visible on its own.
const EVERY_CLAIM_COLUMN_SET: ReadClaimState = {
  claimedByUserId: 'rui',
  claimedAt: WRITE_INSTANT,
  claimReleasedByUserId: 'maria',
  claimReleasedAt: EARLIER_INSTANT,
  claimTakenOverFromUserId: 'ana',
};

function buildReadService(
  callerParticipant: ConversationParticipant,
  claimState: ReadClaimState = EVERY_CLAIM_COLUMN_SET,
) {
  const allSeats = [
    customerSeat(),
    seat({ userId: 'rui' }),
    seat({ userId: 'ana' }),
    seat({ userId: 'maria' }),
  ];
  const others = allSeats.filter(
    (other) => other.userId !== callerParticipant.userId,
  );
  const conversation = {
    id: CONVERSATION_ID,
    kind: ConversationKind.Direct,
    isOfficial: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    title: null,
    avatarUrl: null,
    description: null,
    dissolvedAt: null,
    inviteToken: null,
    ...claimState,
    initiatorUserId: CUSTOMER_USER_ID,
    openedAt: new Date('2026-01-01T01:00:00.000Z'),
  };
  const queryBuilder = {} as Record<string, jest.Mock>;
  for (const method of [
    'where',
    'andWhere',
    'setParameter',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'take',
    'select',
    'innerJoin',
  ]) {
    queryBuilder[method] = jest.fn(() => queryBuilder);
  }
  // The caller's own seat is the one inbox row the list read pages over.
  queryBuilder.getRawAndEntities = jest
    .fn()
    .mockResolvedValue({ entities: [callerParticipant], raw: [] });
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  const participantsRepo = {
    find: jest.fn().mockResolvedValue(others),
    findOne: jest.fn().mockResolvedValue(callerParticipant),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const profilesRepo = {
    find: jest.fn(({ where }: { where: { userId: { value: string[] } } }) =>
      Promise.resolve(where.userId.value.map(profileOf)),
    ),
  };
  const identities = {
    getByIds: jest.fn().mockResolvedValue([
      { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
      { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
    ]),
    describeIdentities: jest.fn().mockResolvedValue(
      new Map([
        [
          MAILBOX_IDENTITY_ID,
          {
            displayName: 'Cafe Lisboa',
            handle: 'cafe-lisboa',
            avatarUrl: null,
          },
        ],
      ]),
    ),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
  };
  const core = {
    requireParticipant: jest.fn().mockResolvedValue(callerParticipant),
    lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
    unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
    reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
    hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
    buildMemberPreview: jest.fn().mockReturnValue([]),
    buildMemberSummaries: jest.fn().mockReturnValue([]),
    groupCapabilities: jest.fn().mockReturnValue({}),
    buildLastMessagePreview: (
      ...previewArguments: Parameters<
        MessagingCoreService['buildLastMessagePreview']
      >
    ) =>
      MessagingCoreService.prototype.buildLastMessagePreview.call(
        {},
        ...previewArguments,
      ),
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
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set()),
    isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    identityBlocksAmong: jest.fn().mockResolvedValue([]),
  };
  const service = new ConversationsService(
    {
      find: jest.fn().mockResolvedValue([conversation]),
      findOne: jest.fn().mockResolvedValue(conversation),
    } as never,
    participantsRepo as never,
    profilesRepo as never,
    core as never,
    blockFilter as never,
    { emit: jest.fn() } as never,
    {} as never,
    { getMany: jest.fn().mockResolvedValue(new Map()) } as never,
    {
      allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
      acceptedSinceByCounterpart: jest.fn().mockResolvedValue(new Map()),
    } as never,
    {
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
    } as never,
    identities as never,
    identityAttribution as never,
  );
  return { service, profilesRepo };
}

describe('Task 19: the conversation read names claim changes to staff only', () => {
  it('gives a staff caller who released it, when, and whose claim was taken over', async () => {
    const { service, profilesRepo } = buildReadService(seat({ userId: 'rui' }));

    const result = await service.getConversation(CONVERSATION_ID, 'rui');

    expect(result.claimReleasedBy).toEqual(
      expect.objectContaining({ handle: 'maria-handle' }),
    );
    expect(result.claimReleasedAt).toBe(EARLIER_INSTANT.toISOString());
    expect(result.claimTakenOverFrom).toEqual(
      expect.objectContaining({ handle: 'ana-handle' }),
    );
    // The two new people rode the one batched profile read.
    expect(profilesRepo.find).toHaveBeenCalledTimes(1);
  });

  it('gives the customer null for each of the three fields', async () => {
    const { service } = buildReadService(customerSeat());

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.claimReleasedBy).toBeNull();
    expect(result.claimReleasedAt).toBeNull();
    expect(result.claimTakenOverFrom).toBeNull();
    expect(result.claimedBy).toBeNull();
    expect(JSON.stringify(result)).not.toContain('maria');
    expect(JSON.stringify(result)).not.toContain('ana-handle');
  });
});

describe('Task 19 fix round 1: no claim field reaches a customer, on any read', () => {
  const STAFF_HANDLES = ['rui-handle', 'ana-handle', 'maria-handle'];
  const claimStates: Array<[string, ReadClaimState]> = [
    [
      'claimed',
      {
        claimedByUserId: 'rui',
        claimedAt: WRITE_INSTANT,
        claimReleasedByUserId: null,
        claimReleasedAt: null,
        claimTakenOverFromUserId: null,
      },
    ],
    [
      'released',
      {
        claimedByUserId: null,
        claimedAt: null,
        claimReleasedByUserId: 'maria',
        claimReleasedAt: EARLIER_INSTANT,
        claimTakenOverFromUserId: null,
      },
    ],
    [
      'taken over',
      {
        claimedByUserId: 'rui',
        claimedAt: WRITE_INSTANT,
        claimReleasedByUserId: null,
        claimReleasedAt: null,
        claimTakenOverFromUserId: 'ana',
      },
    ],
  ];

  function expectNoClaimFields(row: Record<string, unknown>) {
    for (const field of [
      'claimedByUserId',
      'claimedBy',
      'claimedAt',
      'claimReleasedBy',
      'claimReleasedAt',
      'claimTakenOverFrom',
    ]) {
      expect(row[field] ?? null).toBeNull();
    }
    const serialized = JSON.stringify(row);
    for (const staffHandle of STAFF_HANDLES) {
      expect(serialized).not.toContain(staffHandle);
    }
    // No staff user id either, quoted as a JSON value.
    for (const staffUserId of ['rui', 'ana', 'maria']) {
      expect(serialized).not.toContain(`"${staffUserId}"`);
    }
  }

  it.each(claimStates)(
    'gives the customer no claim field on a %s thread, in GET /conversations and GET /conversations/:id',
    async (_label, claimState) => {
      const { service } = buildReadService(customerSeat(), claimState);

      const page = await service.listConversations(CUSTOMER_USER_ID, {});
      const legacyList = await service.listConversations(CUSTOMER_USER_ID);
      const detail = await service.getConversation(
        CONVERSATION_ID,
        CUSTOMER_USER_ID,
      );

      expect(page.data).toHaveLength(1);
      expect(legacyList).toHaveLength(1);
      for (const row of [page.data[0]!, legacyList[0]!, detail]) {
        expectNoClaimFields(row as unknown as Record<string, unknown>);
      }
    },
  );

  it.each(claimStates)(
    'gives a staff viewer the claim fields on a %s thread, in both reads',
    async (_label, claimState) => {
      const { service } = buildReadService(seat({ userId: 'ana' }), claimState);

      const page = await service.listConversations('ana', {});
      const detail = await service.getConversation(CONVERSATION_ID, 'ana');

      for (const row of [
        page.data[0]! as unknown as Record<string, unknown>,
        detail as unknown as Record<string, unknown>,
      ]) {
        expect(row.claimedByUserId).toBe(claimState.claimedByUserId);
        expect(row.claimedBy ?? null).toEqual(
          claimState.claimedByUserId
            ? expect.objectContaining({
                handle: `${claimState.claimedByUserId}-handle`,
              })
            : null,
        );
        expect(row.claimReleasedBy ?? null).toEqual(
          claimState.claimReleasedByUserId
            ? expect.objectContaining({
                handle: `${claimState.claimReleasedByUserId}-handle`,
              })
            : null,
        );
        expect(row.claimReleasedAt).toBe(
          claimState.claimReleasedAt?.toISOString() ?? null,
        );
        expect(row.claimTakenOverFrom ?? null).toEqual(
          claimState.claimTakenOverFromUserId
            ? expect.objectContaining({
                handle: `${claimState.claimTakenOverFromUserId}-handle`,
              })
            : null,
        );
      }
    },
  );
});

describe('Task 19 fix round 2: a take-over names the current claim only', () => {
  it('reads claimTakenOverFrom as null on an unclaimed row whose column a system release or an erased claimant left set', async () => {
    const { service } = buildReadService(seat({ userId: 'maria' }), {
      claimedByUserId: null,
      claimedAt: null,
      claimReleasedByUserId: null,
      claimReleasedAt: WRITE_INSTANT,
      claimTakenOverFromUserId: 'ana',
    });

    const detail = await service.getConversation(CONVERSATION_ID, 'maria');
    const page = await service.listConversations('maria', {});

    for (const row of [detail, page.data[0]!]) {
      expect(row.claimedBy).toBeNull();
      expect(row.claimTakenOverFrom).toBeNull();
      expect(row.claimReleasedAt).toBe(WRITE_INSTANT.toISOString());
    }
  });
});

describe('Task 19 fix round 2: claim instants come from the database', () => {
  it('reads the RETURNING value', () => {
    expect(
      returnedTimestamp([{ claimed_at: WRITE_INSTANT }], 'claimed_at'),
    ).toEqual(WRITE_INSTANT);
  });

  it('throws when the write returned no value for the column', () => {
    expect(() =>
      returnedTimestamp([{ claimed_at: WRITE_INSTANT }], 'claim_released_at'),
    ).toThrow('The claim write returned no claim_released_at value');
    expect(() => returnedTimestamp([], 'claimed_at')).toThrow();
  });
});
