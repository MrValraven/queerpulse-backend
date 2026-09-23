import { FindOperator } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import {
  blockedStaffSeatPredicate,
  departedStaffSeatPredicate,
  describeDirectThreadSeats,
  identityBlockedCustomerSeatPredicate,
  isDepartedStaffSeat,
  isSeatExcludedFromMailbox,
  isStaffSeatExcludedFromMailbox,
  loadMailboxIdentityBlockKeys,
  loadReachableMailboxSeats,
  mailboxIdentityBlockCandidates,
  mailboxIdentityBlockKey,
  MailboxThreadPartition,
  NO_MAILBOX_IDENTITY_BLOCKS,
  NOT_A_DIRECT_THREAD,
  partitionMailboxThreadSeats,
  seatExcludedFromMailboxPredicate,
  staffSeatExcludedFromMailboxPredicate,
} from './mailbox-seats';

/**
 * Task 13c fix round 1: the seat rules Task 13d will build socket and push
 * audiences on.
 */

const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const identityKindById = new Map([
  [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
  [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
]);

function seat(
  userId: string,
  identityId: string,
  leftAt: Date | null = null,
): ConversationParticipant {
  return { userId, identityId, leftAt } as unknown as ConversationParticipant;
}

const customer = seat('customer-1', CUSTOMER_IDENTITY_ID);
const liveStaff = seat('staff-1', MAILBOX_IDENTITY_ID);
const departedStaff = seat(
  'staff-2',
  MAILBOX_IDENTITY_ID,
  new Date('2026-01-01T00:00:00.000Z'),
);

describe('partitionMailboxThreadSeats', () => {
  it('partitions a thread with no caller: the mailbox identity, the customer seat and the staff seats', () => {
    const partition = partitionMailboxThreadSeats(
      [departedStaff, customer, liveStaff],
      identityKindById,
      { shouldIncludeDepartedSeats: true },
    );

    expect(partition?.mailboxIdentityId).toBe(MAILBOX_IDENTITY_ID);
    expect(partition?.customerSeat).toBe(customer);
    expect(partition?.staffSeats).toEqual([departedStaff, liveStaff]);
  });

  it('leaves a staff member who departed the mailbox out of a live audience', () => {
    const partition = partitionMailboxThreadSeats(
      [departedStaff, customer, liveStaff],
      identityKindById,
      { shouldIncludeDepartedSeats: false },
    );

    expect(partition?.staffSeats).toEqual([liveStaff]);
  });

  it('declines to partition a thread whose seats do not all resolve', () => {
    expect(
      partitionMailboxThreadSeats(
        [customer, seat('staff-3', 'identity-unresolved')],
        identityKindById,
        { shouldIncludeDepartedSeats: true },
      ),
    ).toBeUndefined();
  });
});

describe('describeDirectThreadSeats', () => {
  it('reports departed staff seats among a customer view, as its doc says', () => {
    const seats = describeDirectThreadSeats(
      CUSTOMER_IDENTITY_ID,
      [departedStaff, liveStaff],
      identityKindById,
    );

    expect(seats.mailboxStaffSeats).toEqual([departedStaff, liveStaff]);
    expect(seats.otherSeats).toEqual([departedStaff, liveStaff]);
  });
});

describe('NOT_A_DIRECT_THREAD', () => {
  it('is frozen, arrays included, so no caller can change the shared value', () => {
    expect(Object.isFrozen(NOT_A_DIRECT_THREAD)).toBe(true);
    expect(Object.isFrozen(NOT_A_DIRECT_THREAD.counterpartSeats)).toBe(true);
    expect(Object.isFrozen(NOT_A_DIRECT_THREAD.mailboxStaffSeats)).toBe(true);
    expect(Object.isFrozen(NOT_A_DIRECT_THREAD.otherSeats)).toBe(true);
  });
});

describe('loadReachableMailboxSeats', () => {
  // Task 13e: the one home of the staff-seat block rule for every audience
  // built from the partition. Blocks are stored directed, and the real
  // `BlockFilterService` reads them, so both directions go through the same
  // query the live frames and the push listener use.
  const colleague = seat('staff-3', MAILBOX_IDENTITY_ID);
  const partition: MailboxThreadPartition = {
    mailboxIdentityId: MAILBOX_IDENTITY_ID,
    customerSeat: customer,
    staffSeats: [liveStaff, colleague],
  };

  function blockFilterOver(
    blocks: Array<{ blockerId: string; blockedId: string }>,
    identityBlocks: Array<{ blockerUserId: string; identityId: string }> = [],
  ): BlockFilterService {
    const matches = (expected: unknown, actual: string) =>
      expected instanceof FindOperator
        ? (expected.value as string[]).includes(actual)
        : expected === actual;
    const blockRepository = {
      find: ({
        where,
      }: {
        where: Array<{ blockerId: unknown; blockedId: unknown }>;
      }) =>
        Promise.resolve(
          blocks.filter((block) =>
            where.some(
              (clause) =>
                matches(clause.blockerId, block.blockerId) &&
                matches(clause.blockedId, block.blockedId),
            ),
          ),
        ),
    };
    const identityBlockRepository = {
      find: ({
        where,
      }: {
        where: { blockerUserId: unknown; identityId: unknown };
      }) =>
        Promise.resolve(
          identityBlocks.filter(
            (identityBlock) =>
              matches(where.blockerUserId, identityBlock.blockerUserId) &&
              matches(where.identityId, identityBlock.identityId),
          ),
        ),
    };
    return new BlockFilterService(
      blockRepository as never,
      {} as never,
      identityBlockRepository as never,
    );
  }

  const reachableStaffOf = async (
    blockFilter: BlockFilterService,
  ): Promise<ConversationParticipant[]> =>
    (await loadReachableMailboxSeats(partition, identityKindById, blockFilter))
      .staffSeats;

  it('keeps every live staff seat when nobody is blocked', async () => {
    await expect(reachableStaffOf(blockFilterOver([]))).resolves.toEqual([
      liveStaff,
      colleague,
    ]);
  });

  it('removes a staff member the customer blocked, and keeps the colleague', async () => {
    await expect(
      reachableStaffOf(
        blockFilterOver([{ blockerId: 'customer-1', blockedId: 'staff-1' }]),
      ),
    ).resolves.toEqual([colleague]);
  });

  it('removes a staff member who blocked the customer, and keeps the colleague', async () => {
    await expect(
      reachableStaffOf(
        blockFilterOver([{ blockerId: 'staff-1', blockedId: 'customer-1' }]),
      ),
    ).resolves.toEqual([colleague]);
  });

  it('Task 14: reaches nobody, customer or staff, once the customer blocked the business', async () => {
    const reachableSeats = await loadReachableMailboxSeats(
      partition,
      identityKindById,
      blockFilterOver(
        [],
        [{ blockerUserId: 'customer-1', identityId: MAILBOX_IDENTITY_ID }],
      ),
    );

    expect(reachableSeats).toEqual({ customerSeat: undefined, staffSeats: [] });
  });

  it('Task 14: reaches the customer and every staff seat when the customer blocked a different business', async () => {
    const reachableSeats = await loadReachableMailboxSeats(
      partition,
      identityKindById,
      blockFilterOver(
        [],
        [
          {
            blockerUserId: 'customer-1',
            identityId: 'identity-other-business',
          },
        ],
      ),
    );

    expect(reachableSeats).toEqual({
      customerSeat: customer,
      staffSeats: [liveStaff, colleague],
    });
  });

  it('Task 14: reaches the business for a customer who blocked a staff member as a person, the owner included', async () => {
    const reachableSeats = await loadReachableMailboxSeats(
      partition,
      identityKindById,
      blockFilterOver([{ blockerId: 'customer-1', blockedId: 'staff-1' }]),
    );

    expect(reachableSeats.customerSeat).toBe(customer);
  });

  it('keeps both colleagues when the block is between the two of them', async () => {
    await expect(
      reachableStaffOf(
        blockFilterOver([{ blockerId: 'staff-3', blockedId: 'staff-1' }]),
      ),
    ).resolves.toEqual([liveStaff, colleague]);
  });
});

describe('Task 14a: a staff member who left the business', () => {
  const colleague = seat('staff-3', MAILBOX_IDENTITY_ID);
  const partitionWithDepartedSeat: MailboxThreadPartition = {
    mailboxIdentityId: MAILBOX_IDENTITY_ID,
    customerSeat: customer,
    staffSeats: [liveStaff, departedStaff, colleague],
  };
  const noBlocks = new Set<string>();

  function describedFrom(ownSeat: ConversationParticipant) {
    return describeDirectThreadSeats(
      ownSeat.identityId,
      [customer, liveStaff, departedStaff, colleague].filter(
        (otherSeat) => otherSeat !== ownSeat,
      ),
      identityKindById,
    );
  }

  it('excludes the departed staff seat, and keeps the live colleague and the customer', () => {
    expect(
      isStaffSeatExcludedFromMailbox(
        departedStaff,
        describedFrom(departedStaff),
        noBlocks,
        NO_MAILBOX_IDENTITY_BLOCKS,
      ),
    ).toBe(true);
    expect(
      isStaffSeatExcludedFromMailbox(
        colleague,
        describedFrom(colleague),
        noBlocks,
        NO_MAILBOX_IDENTITY_BLOCKS,
      ),
    ).toBe(false);
    expect(
      isStaffSeatExcludedFromMailbox(
        customer,
        describedFrom(customer),
        noBlocks,
        NO_MAILBOX_IDENTITY_BLOCKS,
      ),
    ).toBe(false);
  });

  it('leaves a seat that speaks for the member themself alone, as a group leaver or a departed customer', () => {
    const leftCustomer = seat(
      'customer-1',
      CUSTOMER_IDENTITY_ID,
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(
      isDepartedStaffSeat(
        leftCustomer,
        describeDirectThreadSeats(
          CUSTOMER_IDENTITY_ID,
          [liveStaff],
          identityKindById,
        ),
      ),
    ).toBe(false);
    expect(isDepartedStaffSeat(leftCustomer, NOT_A_DIRECT_THREAD)).toBe(false);
  });

  it('keeps the block rule inside the same call', () => {
    expect(
      isStaffSeatExcludedFromMailbox(
        liveStaff,
        describedFrom(liveStaff),
        new Set(['customer-1']),
        NO_MAILBOX_IDENTITY_BLOCKS,
      ),
    ).toBe(true);
  });

  it('restores access once the seat is reactivated', () => {
    const reseatedStaff = seat('staff-2', MAILBOX_IDENTITY_ID);

    expect(
      isStaffSeatExcludedFromMailbox(
        reseatedStaff,
        describedFrom(departedStaff),
        noBlocks,
        NO_MAILBOX_IDENTITY_BLOCKS,
      ),
    ).toBe(false);
  });

  it('leaves the departed seat out of the live and push audience, even from a partition that kept it', async () => {
    const blockFilter = {
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
      identityBlocksAmong: jest.fn().mockResolvedValue([]),
    };

    const reachableSeats = await loadReachableMailboxSeats(
      partitionWithDepartedSeat,
      identityKindById,
      blockFilter,
    );

    expect(reachableSeats.staffSeats).toEqual([liveStaff, colleague]);
  });

  it('composes the block predicate and the departed predicate into one SQL rule', () => {
    const combined = staffSeatExcludedFromMailboxPredicate(
      'seat.conversation_id',
      'seat.user_id',
    );

    expect(combined).toBe(
      `(${blockedStaffSeatPredicate('seat.conversation_id', 'seat.user_id')} OR ${departedStaffSeatPredicate('seat.conversation_id', 'seat.user_id')})`,
    );
  });

  it('asks the departed predicate about the seat itself: set leftAt on a non-profile identity of a direct, non-official thread', () => {
    const departedSql = departedStaffSeatPredicate(
      'seat.conversation_id',
      ':userId',
    );

    expect(departedSql).toContain(
      `"departed_staff_seat"."conversation_id" = seat.conversation_id`,
    );
    expect(departedSql).toContain(`"departed_staff_seat"."user_id" = :userId`);
    expect(departedSql).toContain(
      `"departed_staff_seat"."left_at" IS NOT NULL`,
    );
    expect(departedSql).toContain(
      `"departed_staff_identity"."kind" <> 'profile'`,
    );
    expect(departedSql).toContain(
      `"departed_staff_conversation"."kind" <> 'group'`,
    );
    expect(departedSql).toContain(
      `"departed_staff_conversation"."is_official" = false`,
    );
  });

  it('defines every quoted alias the departed predicate references', () => {
    const departedSql = departedStaffSeatPredicate(
      'seat.conversation_id',
      ':userId',
    );
    const definedAliases = new Set(
      [
        ...departedSql.matchAll(
          /FROM "[a-z_]+" "([a-z_]+)"|JOIN "[a-z_]+" "([a-z_]+)"/g,
        ),
      ].map((match) => match[1] ?? match[2]),
    );
    const referencedAliases = new Set(
      [...departedSql.matchAll(/"([a-z_]+)"\."[a-z_]+"/g)].map(
        (match) => match[1],
      ),
    );

    expect([...referencedAliases].sort()).toEqual([...definedAliases].sort());
  });
});

describe('Task 14: a customer who blocked the business as a whole', () => {
  const colleague = seat('staff-3', MAILBOX_IDENTITY_ID);
  const threadSeats = [customer, liveStaff, colleague];
  const noPersonBlocks = new Set<string>();
  const blockOfThisBusiness = new Set([
    mailboxIdentityBlockKey('customer-1', MAILBOX_IDENTITY_ID),
  ]);

  function describedFrom(ownSeat: ConversationParticipant) {
    return describeDirectThreadSeats(
      ownSeat.identityId,
      threadSeats.filter((otherSeat) => otherSeat !== ownSeat),
      identityKindById,
    );
  }

  it('excludes the customer and every staff seat of that business', () => {
    for (const ownSeat of threadSeats) {
      expect(
        isSeatExcludedFromMailbox(
          ownSeat,
          describedFrom(ownSeat),
          noPersonBlocks,
          blockOfThisBusiness,
        ),
      ).toBe(true);
    }
  });

  it('excludes nobody once the block is lifted, or when the block names a different business', () => {
    const blockOfAnotherBusiness = new Set([
      mailboxIdentityBlockKey('customer-1', 'identity-other-business'),
    ]);

    for (const ownSeat of threadSeats) {
      for (const identityBlockKeys of [
        NO_MAILBOX_IDENTITY_BLOCKS,
        blockOfAnotherBusiness,
      ]) {
        expect(
          isSeatExcludedFromMailbox(
            ownSeat,
            describedFrom(ownSeat),
            noPersonBlocks,
            identityBlockKeys,
          ),
        ).toBe(false);
      }
    }
  });

  it("asks for the customer's block of the mailbox identity, from either side", () => {
    expect(
      mailboxIdentityBlockCandidates(customer, describedFrom(customer)),
    ).toEqual([
      { blockerUserId: 'customer-1', identityId: MAILBOX_IDENTITY_ID },
    ]);
    expect(
      mailboxIdentityBlockCandidates(liveStaff, describedFrom(liveStaff)),
    ).toEqual([
      { blockerUserId: 'customer-1', identityId: MAILBOX_IDENTITY_ID },
    ]);
    expect(
      mailboxIdentityBlockCandidates(customer, NOT_A_DIRECT_THREAD),
    ).toEqual([]);
  });

  it('keeps only the exact pairs asked for from one batched lookup, and asks nothing for no candidates', async () => {
    const blockFilter = {
      identityBlocksAmong: jest.fn().mockResolvedValue([
        { blockerUserId: 'customer-1', identityId: MAILBOX_IDENTITY_ID },
        { blockerUserId: 'customer-2', identityId: MAILBOX_IDENTITY_ID },
      ]),
    };

    const keys = await loadMailboxIdentityBlockKeys(
      [
        { blockerUserId: 'customer-1', identityId: MAILBOX_IDENTITY_ID },
        { blockerUserId: 'customer-2', identityId: 'identity-other-business' },
      ],
      blockFilter,
    );

    expect([...keys]).toEqual([
      mailboxIdentityBlockKey('customer-1', MAILBOX_IDENTITY_ID),
    ]);
    expect(blockFilter.identityBlocksAmong).toHaveBeenCalledTimes(1);
    await expect(loadMailboxIdentityBlockKeys([], blockFilter)).resolves.toBe(
      NO_MAILBOX_IDENTITY_BLOCKS,
    );
    expect(blockFilter.identityBlocksAmong).toHaveBeenCalledTimes(1);
  });

  describe('the SQL', () => {
    const combinedSql = seatExcludedFromMailboxPredicate(
      'seat.conversation_id',
      'seat.user_id',
    );

    function definedAliasesOf(sql: string): string[] {
      return [...sql.matchAll(/(?:FROM|JOIN) "[a-z_]+" "([a-z_]+)"/g)].map(
        (match) => match[1]!,
      );
    }

    function referencedAliasesOf(sql: string): Set<string> {
      return new Set(
        [...sql.matchAll(/"([a-z_]+)"\."[a-z_]+"/g)].map((match) => match[1]!),
      );
    }

    it('composes the staff rule and the customer rule into one predicate', () => {
      expect(combinedSql).toBe(
        `(${staffSeatExcludedFromMailboxPredicate('seat.conversation_id', 'seat.user_id')} OR ${identityBlockedCustomerSeatPredicate('seat.conversation_id', 'seat.user_id')})`,
      );
    });

    it("excludes a staff seat through the customer's identity block of the staff seat's own identity", () => {
      const staffSql = blockedStaffSeatPredicate(
        'seat.conversation_id',
        'seat.user_id',
      );

      expect(staffSql).toContain(
        `SELECT 1 FROM "identity_blocks" "staff_business_identity_block"`,
      );
      expect(staffSql).toContain(
        `"staff_business_identity_block"."blocker_user_id" = "blocking_customer_seat"."user_id"`,
      );
      expect(staffSql).toContain(
        `"staff_business_identity_block"."identity_id" = "blocked_staff_seat"."identity_id"`,
      );
    });

    it("excludes the customer's own profile seat through their identity block of another seat's business identity", () => {
      const customerSql = identityBlockedCustomerSeatPredicate(
        'seat.conversation_id',
        'seat.user_id',
      );

      expect(customerSql).toContain(
        `"identity_blocking_customer_seat"."conversation_id" = seat.conversation_id`,
      );
      expect(customerSql).toContain(
        `"identity_blocking_customer_seat"."user_id" = seat.user_id`,
      );
      expect(customerSql).toContain(
        `"customer_business_identity_block"."blocker_user_id" = "identity_blocking_customer_seat"."user_id"`,
      );
      expect(customerSql).toContain(
        `"customer_business_identity_block"."identity_id" = "identity_blocked_business_seat"."identity_id"`,
      );
      expect(customerSql).toContain(
        `"identity_blocking_customer_identity"."kind" = 'profile'`,
      );
      expect(customerSql).toContain(
        `"identity_blocked_business_identity"."kind" <> 'profile'`,
      );
      expect(customerSql).toContain(
        `"identity_blocking_customer_conversation"."kind" <> 'group'`,
      );
      expect(customerSql).toContain(
        `"identity_blocking_customer_conversation"."is_official" = false`,
      );
    });

    it('defines every quoted alias it references, and references every alias it defines', () => {
      expect([...referencedAliasesOf(combinedSql)].sort()).toEqual(
        [...new Set(definedAliasesOf(combinedSql))].sort(),
      );
    });

    it('defines each alias once in the composed query, so no subquery shadows another', () => {
      const composedQuery = `SELECT 1 FROM "conversation_participants" "seat" WHERE "seat"."id" = :seatId AND ${combinedSql}`;
      const definedAliases = definedAliasesOf(composedQuery);

      expect(definedAliases).toHaveLength(new Set(definedAliases).size);
      expect(definedAliases).toEqual(
        expect.arrayContaining([
          'blocked_staff_seat',
          'blocking_customer_seat',
          'staff_customer_block',
          'staff_business_identity_block',
          'departed_staff_seat',
          'identity_blocking_customer_seat',
          'identity_blocked_business_seat',
          'customer_business_identity_block',
        ]),
      );
    });

    it('binds no parameter of its own, so it cannot collide with the query that composes it', () => {
      expect(combinedSql).not.toMatch(/:[A-Za-z]/);
      expect(combinedSql).not.toMatch(/\$\d/);
    });
  });
});

describe('Task 14 fix round 1: a thread seating two businesses fails closed in memory, as in SQL', () => {
  // The data integrity anomaly the review ran on Postgres: one customer
  // seated with staff of two different businesses. The SQL
  // (`identityBlockedCustomerSeatPredicate`) excludes the customer's seat
  // when they blocked EITHER business, because it joins any other seat
  // whose identity is not a profile; the staff arm excludes each staff seat
  // whose own identity the customer blocked. The expected table below is
  // that SQL's answer, confirmed against Postgres in the Task 14 review
  // (thread T6), and the in-memory twin must give the same one.
  const OTHER_BUSINESS_ID = 'identity-other-business';
  const kinds = new Map([
    [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
    [OTHER_BUSINESS_ID, IdentityKind.Company],
    [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
  ]);
  const twoBusinessCustomer = seat('customer-1', CUSTOMER_IDENTITY_ID);
  const firstBusinessStaff = seat('staff-1', MAILBOX_IDENTITY_ID);
  const secondBusinessStaff = seat('staff-9', OTHER_BUSINESS_ID);
  const twoBusinessSeats = [
    twoBusinessCustomer,
    firstBusinessStaff,
    secondBusinessStaff,
  ];

  function excludedSeatUserIds(blockedIdentityIds: string[]): string[] {
    const identityBlockKeys = new Set(
      blockedIdentityIds.map((identityId) =>
        mailboxIdentityBlockKey('customer-1', identityId),
      ),
    );
    return twoBusinessSeats
      .filter((ownSeat) =>
        isSeatExcludedFromMailbox(
          ownSeat,
          describeDirectThreadSeats(
            ownSeat.identityId,
            twoBusinessSeats.filter((otherSeat) => otherSeat !== ownSeat),
            kinds,
          ),
          new Set<string>(),
          identityBlockKeys,
        ),
      )
      .map((ownSeat) => ownSeat.userId);
  }

  it.each([
    [[MAILBOX_IDENTITY_ID], ['customer-1', 'staff-1']],
    [[OTHER_BUSINESS_ID], ['customer-1', 'staff-9']],
  ])(
    'with blocks of %j, excludes exactly the seats the SQL excludes, %j',
    (blockedIdentityIds, expectedExcludedUserIds) => {
      expect(excludedSeatUserIds(blockedIdentityIds)).toEqual(
        expectedExcludedUserIds,
      );
    },
  );

  it("asks for the customer's block of every business on the thread, so the batched loader can see either", () => {
    const customerView = describeDirectThreadSeats(
      CUSTOMER_IDENTITY_ID,
      [firstBusinessStaff, secondBusinessStaff],
      kinds,
    );

    expect(customerView.mailboxIdentityId).toBeUndefined();
    expect(
      mailboxIdentityBlockCandidates(twoBusinessCustomer, customerView),
    ).toEqual([
      { blockerUserId: 'customer-1', identityId: MAILBOX_IDENTITY_ID },
      { blockerUserId: 'customer-1', identityId: OTHER_BUSINESS_ID },
    ]);
  });
});
