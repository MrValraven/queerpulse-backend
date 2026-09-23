import { CONVERSATION_CLAIM_CHANGED } from '../messaging/conversation-claim';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { CONVERSATION_MEMBERSHIP_REVOKED } from '../messaging/messaging.events';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';
import { IdentityMailboxSyncService } from './identity-mailbox-sync.service';
import { IDENTITY_STAFFING_CHANGED } from './identity-staffing.events';

/**
 * A find-operator-aware `WHERE` matcher for the fakes below. Real TypeORM
 * `FindOperator`s (`IsNull()`, `Not()`, `MoreThan()`) carry their kind on
 * `.type` and their operand on `.value`, so a plain `row[key] === value`
 * comparison would never match one. This is the minimum needed to model
 * every predicate `IdentityMailboxSyncService` actually issues.
 */
function isFindOperator(
  value: unknown,
): value is { type: string; value: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'value' in value
  );
}

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (isFindOperator(expected)) {
      switch (expected.type) {
        case 'isNull':
          return actual === null;
        case 'not':
          return actual !== expected.value;
        case 'moreThan':
          return (
            typeof actual === 'string' &&
            typeof expected.value === 'string' &&
            actual > expected.value
          );
        case 'in':
          return (
            Array.isArray(expected.value) && expected.value.includes(actual)
          );
        default:
          throw new Error(`Unmodelled find operator: ${expected.type}`);
      }
    }
    return actual === expected;
  });
}

/** What the stand-in database clock answers for a seat's floor instant. It
 *  lies in the past of any test run, so a floor taken from the application
 *  clock can never equal it: an equal floor provably came from the
 *  database. */
const DATABASE_NOW = new Date('2026-09-15T10:00:00.123Z');

/** The stand-in for the one clock read `seatFloorInstant` issues. */
function databaseClockQuery() {
  return jest.fn((sql: string) => {
    if (!sql.includes('clock_timestamp()')) {
      throw new Error(`Unmodelled query: ${sql}`);
    }
    return Promise.resolve([{ floorInstant: DATABASE_NOW }]);
  });
}

// --- IdentityMailboxSyncService.onStaffAdded / onStaffRemoved --------------
//
// The four tests specified for this task, adapted to the constructor this
// service actually needs: `resyncMailbox` consumes `IdentitiesService
// .staffUserIds`, and the sweep consumes an `Identity` repository, so both
// join the `ConversationParticipant` repository the original brief's
// two-argument sample predates.

function makeService(
  existingConversationIds: string[],
  alreadySeatedIn: string[] = [],
) {
  const participants = {
    find: jest.fn(
      async (options: { where: { identityId?: string; userId?: string } }) => {
        if (options.where.userId) {
          // F2 (I1): the seat read now spans every identity, so each row
          // names the mailbox identity it was seated under.
          return alreadySeatedIn.map((conversationId) => ({
            conversationId,
            identityId: 'business-identity',
          }));
        }
        return existingConversationIds.map((conversationId) => ({
          conversationId,
        }));
      },
    ),
    save: jest.fn(async (rows: unknown[]) => rows),
    update: jest.fn(),
    create: jest.fn((row: unknown) => row),
    query: databaseClockQuery(),
  };
  const identitiesRepository = { find: jest.fn() };
  // No claim in these tests' fixtures, so a claim-release lookup always
  // affects nothing. Claim-release behaviour is covered on its own below.
  const conversations = makeFakeConversationsRepository([]).repository;
  const identitiesService = { staffUserIds: jest.fn() };
  const service = new IdentityMailboxSyncService(
    participants as never,
    identitiesRepository as never,
    conversations as never,
    identitiesService as never,
    { emit: jest.fn() } as never,
  );
  return {
    service,
    participants,
    identitiesRepository,
    conversations,
    identitiesService,
  };
}

describe('IdentityMailboxSyncService', () => {
  it('seats a new staff member in every thread of the mailbox', async () => {
    const { service, participants } = makeService([
      'conversation-1',
      'conversation-2',
    ]);
    await service.onStaffAdded('business-identity', 'new-staff');
    const savedCall = participants.save.mock.calls[0];
    if (!savedCall) {
      throw new Error('Expected onStaffAdded to save the newly-seated rows');
    }
    const saved = savedCall[0] as Array<{
      conversationId: string;
      userId: string;
      identityId: string;
      clearedAt: Date;
    }>;
    expect(saved.map((row) => row.conversationId)).toEqual([
      'conversation-1',
      'conversation-2',
    ]);
    expect(saved.every((row) => row.userId === 'new-staff')).toBe(true);
    expect(saved.every((row) => row.identityId === 'business-identity')).toBe(
      true,
    );
  });

  it('gives a new staff member a history floor and a clear point at the one database instant', async () => {
    const { service, participants } = makeService([
      'conversation-1',
      'conversation-2',
    ]);
    await service.onStaffAdded('business-identity', 'new-staff');
    const savedCall = participants.save.mock.calls[0];
    if (!savedCall) {
      throw new Error('Expected onStaffAdded to save the newly-seated row');
    }
    const saved = savedCall[0] as Array<{
      clearedAt: Date | null;
      historyFloorAt: Date | null;
    }>;
    expect(saved).toHaveLength(2);
    for (const savedRow of saved) {
      expect(savedRow.historyFloorAt).toEqual(DATABASE_NOW);
      expect(savedRow.clearedAt).toEqual(DATABASE_NOW);
    }
    // One clock read for the whole seating, truncated to a whole
    // millisecond in SQL.
    expect(participants.query).toHaveBeenCalledTimes(1);
    expect(participants.query).toHaveBeenCalledWith(
      `SELECT date_trunc('milliseconds', clock_timestamp()) AS "floorInstant"`,
    );
  });

  it('is idempotent, skipping threads the member already sits in', async () => {
    const { service, participants } = makeService(
      ['conversation-1'],
      ['conversation-1'],
    );
    await service.onStaffAdded('business-identity', 'existing-staff');
    const saved = participants.save.mock.calls[0]?.[0];
    expect(saved ?? []).toHaveLength(0);
    // Nobody to seat, so no clock read either.
    expect(participants.query).not.toHaveBeenCalled();
  });

  it('marks rows left, keeping them, when staff leave', async () => {
    const { service, participants } = makeService(['conversation-1']);
    await service.onStaffRemoved('business-identity', 'departing-staff');
    expect(participants.update).toHaveBeenCalledWith(
      expect.objectContaining({
        identityId: 'business-identity',
        userId: 'departing-staff',
      }),
      expect.objectContaining({ leftAt: expect.anything() }),
    );
  });
});

// --- A stateful fake, for the scenarios above that need one -----------------
//
// The two-shape mock above (`existingConversationIds` / `alreadySeatedIn`)
// cannot express a mailbox with several DIFFERENT users in several DIFFERENT
// states at once, which `resyncMailbox` and the returning-member case both
// need. This fake actually holds rows and mutates them the way Postgres
// would, so the invariant under test is that the row set converges to the
// right shape, a stronger guarantee than a mock simply being called with the
// right arguments.

interface FakeParticipantRow {
  id: string;
  conversationId: string;
  userId: string;
  identityId: string;
  leftAt: Date | null;
  clearedAt: Date | null;
  historyFloorAt: Date | null;
}

function makeFakeParticipantsRepository(seedRows: FakeParticipantRow[]) {
  let rows = seedRows.map((row) => ({ ...row }));
  let nextGeneratedId = 1;

  const repository = {
    find: jest.fn(async (options: { where: Record<string, unknown> }) =>
      rows
        .filter((row) => matchesWhere(row, options.where))
        .map((row) => ({ ...row })),
    ),
    create: jest.fn(
      (partial: Partial<FakeParticipantRow>): FakeParticipantRow => ({
        id: `generated-${nextGeneratedId++}`,
        leftAt: null,
        clearedAt: null,
        historyFloorAt: null,
        conversationId: '',
        userId: '',
        identityId: '',
        ...partial,
      }),
    ),
    save: jest.fn(async (rowsToSave: FakeParticipantRow[]) => {
      for (const row of rowsToSave) {
        rows.push({ ...row });
      }
      return rowsToSave;
    }),
    update: jest.fn(
      async (
        where: Record<string, unknown>,
        partial: Partial<FakeParticipantRow>,
      ) => {
        let affected = 0;
        rows = rows.map((row) => {
          if (matchesWhere(row, where)) {
            affected += 1;
            return { ...row, ...partial };
          }
          return row;
        });
        return { affected, raw: [], generatedMaps: [] };
      },
    ),
    query: databaseClockQuery(),
  };

  return {
    repository,
    rowsSnapshot: () => rows.map((row) => ({ ...row })),
    // Stands in for a rollback: puts back the rows a transaction started
    // from.
    replaceRows: (savedRows: FakeParticipantRow[]) => {
      rows = savedRows.map((row) => ({ ...row }));
    },
  };
}

function seatRow(overrides: Partial<FakeParticipantRow>): FakeParticipantRow {
  return {
    id: `seat-${Math.random()}`,
    conversationId: 'conversation-1',
    userId: 'someone',
    identityId: 'business-identity',
    leftAt: null,
    clearedAt: null,
    historyFloorAt: null,
    ...overrides,
  };
}

// The same stateful-fake approach as `makeFakeParticipantsRepository`,
// for the `conversations` side of a claim release: real rows, mutated the
// way Postgres would, so a test can assert the row's final shape instead
// of only that the mock was called.
interface FakeConversationRow {
  id: string;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  claimReleasedByUserId: string | null;
  claimReleasedAt: Date | null;
  claimTakenOverFromUserId: string | null;
}

/** The one conditional release `unseatUser` issues through the query
 * builder (Task 25: `UPDATE ... RETURNING id`), modelled on the same rows.
 * Any other condition is unmodelled and throws, so a drifted query fails
 * loudly. */
const MODELLED_RELEASE_CONDITIONS = [
  'id IN (:...mailboxConversationIds)',
  'claimed_by_user_id = :userId',
];

function makeFakeConversationsRepository(seedRows: FakeConversationRow[]) {
  let rows = seedRows.map((row) => ({ ...row }));

  const createQueryBuilder = jest.fn(() => {
    let values: Partial<FakeConversationRow> = {};
    const conditions: string[] = [];
    const parameters: Record<string, unknown> = {};
    const addCondition = (
      condition: string,
      conditionParameters: Record<string, unknown>,
    ) => {
      conditions.push(condition);
      Object.assign(parameters, conditionParameters);
      return builder;
    };
    const builder = {
      update: () => builder,
      set: (nextValues: Partial<FakeConversationRow>) => {
        values = nextValues;
        return builder;
      },
      where: addCondition,
      andWhere: addCondition,
      returning: () => builder,
      execute: async () => {
        if (
          JSON.stringify(conditions) !==
          JSON.stringify(MODELLED_RELEASE_CONDITIONS)
        ) {
          throw new Error(`Unmodelled release: ${conditions.join(' AND ')}`);
        }
        const conversationIds = parameters.mailboxConversationIds as string[];
        const releasedIds: string[] = [];
        rows = rows.map((row) => {
          if (
            conversationIds.includes(row.id) &&
            row.claimedByUserId === parameters.userId
          ) {
            releasedIds.push(row.id);
            return { ...row, ...values };
          }
          return row;
        });
        return {
          affected: releasedIds.length,
          raw: releasedIds.map((id) => ({ id })),
          generatedMaps: [],
        };
      },
    };
    return builder;
  });

  const repository = {
    createQueryBuilder,
    update: jest.fn(
      async (
        where: Record<string, unknown>,
        partial: Partial<FakeConversationRow>,
      ) => {
        let affected = 0;
        rows = rows.map((row) => {
          if (matchesWhere(row, where)) {
            affected += 1;
            return { ...row, ...partial };
          }
          return row;
        });
        return { affected, raw: [], generatedMaps: [] };
      },
    ),
  };

  return { repository, rowsSnapshot: () => rows.map((row) => ({ ...row })) };
}

function claimedConversationRow(
  overrides: Partial<FakeConversationRow>,
): FakeConversationRow {
  return {
    id: 'conversation-1',
    claimedByUserId: null,
    claimedAt: null,
    claimReleasedByUserId: null,
    claimReleasedAt: null,
    claimTakenOverFromUserId: null,
    ...overrides,
  };
}

describe('IdentityMailboxSyncService.resyncMailbox', () => {
  it('seats a staff member who has no seat yet', async () => {
    const { repository, rowsSnapshot } = makeFakeParticipantsRepository([
      seatRow({ userId: 'owner' }),
    ]);
    const identitiesService = {
      staffUserIds: jest.fn().mockResolvedValue(['owner', 'new-comanager']),
    };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncMailbox('business-identity');

    const rows = rowsSnapshot();
    const newRow = rows.find((row) => row.userId === 'new-comanager');
    expect(newRow).toBeDefined();
    expect(newRow?.leftAt).toBeNull();
    expect(newRow?.clearedAt).toEqual(DATABASE_NOW);
    expect(newRow?.historyFloorAt).toEqual(DATABASE_NOW);
    // The staff member who was already seated is untouched.
    expect(rows.filter((row) => row.userId === 'owner')).toHaveLength(1);
  });

  it('ends the seat of someone no longer on the staff list', async () => {
    // `new-owner` already held an active seat (e.g. as a former co-manager)
    // before becoming sole staff, so this test isolates the removal half of
    // reconciliation from the "seat a missing member" half already covered
    // above: staffUserIds narrows to `new-owner` alone, and the two seats not
    // on that list must end without a new row being created for anyone.
    const { repository, rowsSnapshot } = makeFakeParticipantsRepository([
      seatRow({ userId: 'old-owner' }),
      seatRow({ userId: 'comanager' }),
      seatRow({ userId: 'new-owner' }),
    ]);
    const identitiesService = {
      staffUserIds: jest.fn().mockResolvedValue(['new-owner']),
    };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncMailbox('business-identity');

    const rows = rowsSnapshot();
    expect(
      rows.find((row) => row.userId === 'old-owner')?.leftAt,
    ).toBeInstanceOf(Date);
    expect(
      rows.find((row) => row.userId === 'comanager')?.leftAt,
    ).toBeInstanceOf(Date);
    expect(rows.find((row) => row.userId === 'new-owner')?.leftAt).toBeNull();
    // No row was created: three seats in, three seats out.
    expect(rows).toHaveLength(3);
  });

  it('does nothing when the staff list already matches the seats', async () => {
    const { repository, rowsSnapshot } = makeFakeParticipantsRepository([
      seatRow({ userId: 'owner' }),
      seatRow({ userId: 'comanager' }),
    ]);
    const identitiesService = {
      staffUserIds: jest.fn().mockResolvedValue(['owner', 'comanager']),
    };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncMailbox('business-identity');

    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(rowsSnapshot()).toHaveLength(2);
  });

  it('is idempotent across two consecutive runs', async () => {
    const { repository } = makeFakeParticipantsRepository([
      seatRow({ userId: 'owner' }),
    ]);
    const identitiesService = {
      staffUserIds: jest.fn().mockResolvedValue(['owner', 'new-comanager']),
    };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncMailbox('business-identity');
    repository.save.mockClear();
    repository.update.mockClear();

    await service.resyncMailbox('business-identity');

    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });
});

// --- The returning-member case, unassumed -----------------------------------
//
// `inviteToLoadedListing`'s terminal-row reuse (and the equivalent accept
// path for a subprofile or a company) means the same person can be seated,
// unseated, and seated again. This proves the second `onStaffAdded` reuses
// the row `onStaffRemoved` left behind instead of assuming it, per the task
// brief's explicit instruction not to assume idempotence here.
describe('IdentityMailboxSyncService returning-member idempotency', () => {
  it('seat, remove, seat again leaves one row with leftAt cleared', async () => {
    const { repository, rowsSnapshot } = makeFakeParticipantsRepository([
      seatRow({ userId: 'owner', conversationId: 'conversation-1' }),
    ]);
    const identitiesService = { staffUserIds: jest.fn() };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.onStaffAdded('business-identity', 'comanager-1');
    await service.onStaffRemoved('business-identity', 'comanager-1');
    await service.onStaffAdded('business-identity', 'comanager-1');

    const comanagerRows = rowsSnapshot().filter(
      (row) => row.userId === 'comanager-1',
    );
    expect(comanagerRows).toHaveLength(1);
    const [comanagerRow] = comanagerRows;
    if (!comanagerRow) {
      throw new Error('Expected exactly one row for comanager-1');
    }
    expect(comanagerRow.leftAt).toBeNull();
  });
});

// --- CW-26: a rehire gets the same history floor a new hire gets -----------
//
// Cleanup wave ruling: a rehired staff member is just a staff member again,
// so `clearedAt` and `historyFloorAt` on the reactivated row must be floored
// at the database's now, the exact floor a brand-new hire gets. An earlier rule floored this at the later of
// the row's old `clearedAt` and the moment they left, handing a returning
// member a window back into everything since their departure date.
describe('IdentityMailboxSyncService rehire floor (CW-26)', () => {
  it('floors a rehire at now, matching a brand-new hire', async () => {
    const oldClearedAt = new Date('2020-01-01T00:00:00Z');
    const departedAt = new Date('2024-06-01T00:00:00Z');
    const { repository, rowsSnapshot } = makeFakeParticipantsRepository([
      seatRow({
        userId: 'rehired-staff',
        conversationId: 'conversation-1',
        clearedAt: oldClearedAt,
        leftAt: departedAt,
      }),
    ]);
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      { staffUserIds: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await service.onStaffAdded('business-identity', 'rehired-staff');

    const rehiredRows = rowsSnapshot().filter(
      (row) => row.userId === 'rehired-staff',
    );
    expect(rehiredRows).toHaveLength(1);
    const [rehiredRow] = rehiredRows;
    if (!rehiredRow) {
      throw new Error('Expected exactly one row for rehired-staff');
    }
    expect(rehiredRow.leftAt).toBeNull();
    // The old rule would have set this to `departedAt` (the later of the two
    // prior values). The floor here must be `now`, matching a new hire.
    expect(rehiredRow.clearedAt).not.toEqual(departedAt);
    expect(rehiredRow.clearedAt).not.toEqual(oldClearedAt);
    expect(rehiredRow.clearedAt).toEqual(DATABASE_NOW);
    expect(rehiredRow.historyFloorAt).toEqual(DATABASE_NOW);
  });

  it('gives a rehire the identical floor a brand-new hire in the same mailbox gets', async () => {
    const departedAt = new Date('2024-06-01T00:00:00Z');
    const { repository, rowsSnapshot } = makeFakeParticipantsRepository([
      seatRow({
        userId: 'rehired-staff',
        conversationId: 'conversation-1',
        clearedAt: new Date('2020-01-01T00:00:00Z'),
        leftAt: departedAt,
      }),
      seatRow({
        userId: 'owner',
        conversationId: 'conversation-1',
      }),
    ]);
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      { staffUserIds: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await service.onStaffAdded('business-identity', 'rehired-staff');
    await service.onStaffAdded('business-identity', 'brand-new-hire');

    const rows = rowsSnapshot();
    const rehiredRow = rows.find((row) => row.userId === 'rehired-staff');
    const newHireRow = rows.find((row) => row.userId === 'brand-new-hire');
    if (!rehiredRow || !newHireRow) {
      throw new Error('Expected both rows to exist');
    }
    // Both floors come from the one stand-in database clock, so the rehire
    // and the new hire share the exact instant, and it lies after the old
    // departure date.
    expect(rehiredRow.clearedAt).toEqual(DATABASE_NOW);
    expect(rehiredRow.historyFloorAt).toEqual(newHireRow.historyFloorAt);
    expect(newHireRow.clearedAt).toEqual(DATABASE_NOW);
    expect(newHireRow.historyFloorAt).toEqual(DATABASE_NOW);
  });
});

// --- Task 12b: a departing staff member's own claim is released -------------
//
// A claimed thread narrows push to the claimant alone. A claimant whose seat
// has just ended is dropped by that same narrowing, ordinary `leftAt` filter,
// so an unreleased claim would leave the thread silent indefinitely. These
// tests cover the release side of that fix, independent of the seat-ending
// assertions above.
describe('IdentityMailboxSyncService releases a departing claimant', () => {
  it('clears the claim on that mailbox thread when the departing user is the claimant', async () => {
    const { repository: participantsRepository } =
      makeFakeParticipantsRepository([
        seatRow({
          userId: 'claimant-1',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
      ]);
    const claimedAt = new Date('2026-01-01T00:00:00Z');
    const { repository: conversationsRepository, rowsSnapshot } =
      makeFakeConversationsRepository([
        claimedConversationRow({
          id: 'conversation-1',
          claimedByUserId: 'claimant-1',
          claimedAt,
        }),
      ]);
    const service = new IdentityMailboxSyncService(
      participantsRepository as never,
      { find: jest.fn() } as never,
      conversationsRepository as never,
      { staffUserIds: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await service.onStaffRemoved('mailbox-A', 'claimant-1');

    const [conversation] = rowsSnapshot();
    if (!conversation) {
      throw new Error('Expected the conversation row to still exist');
    }
    expect(conversation.claimedByUserId).toBeNull();
    expect(conversation.claimedAt).toBeNull();
  });

  it('leaves the claim alone when the departing user is not the claimant', async () => {
    const { repository: participantsRepository } =
      makeFakeParticipantsRepository([
        seatRow({
          userId: 'departing-1',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
      ]);
    const claimedAt = new Date('2026-01-01T00:00:00Z');
    const { repository: conversationsRepository, rowsSnapshot } =
      makeFakeConversationsRepository([
        claimedConversationRow({
          id: 'conversation-1',
          claimedByUserId: 'someone-else',
          claimedAt,
        }),
      ]);
    const service = new IdentityMailboxSyncService(
      participantsRepository as never,
      { find: jest.fn() } as never,
      conversationsRepository as never,
      { staffUserIds: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await service.onStaffRemoved('mailbox-A', 'departing-1');

    const [conversation] = rowsSnapshot();
    if (!conversation) {
      throw new Error('Expected the conversation row to still exist');
    }
    expect(conversation.claimedByUserId).toBe('someone-else');
    expect(conversation.claimedAt).toEqual(claimedAt);
  });

  it("scopes the release to the mailbox being unseated, leaving the same person's claim in a different mailbox by value", async () => {
    // The transposition-shaped risk: a person staff of two mailboxes leaves
    // one of them. Releasing mailbox A's claim must never reach mailbox B's,
    // even though the same user holds both.
    const { repository: participantsRepository } =
      makeFakeParticipantsRepository([
        seatRow({
          userId: 'claimant-1',
          conversationId: 'conversation-A',
          identityId: 'mailbox-A',
        }),
        seatRow({
          userId: 'claimant-1',
          conversationId: 'conversation-B',
          identityId: 'mailbox-B',
        }),
      ]);
    const claimedAtA = new Date('2026-01-01T00:00:00Z');
    const claimedAtB = new Date('2026-02-02T00:00:00Z');
    const { repository: conversationsRepository, rowsSnapshot } =
      makeFakeConversationsRepository([
        claimedConversationRow({
          id: 'conversation-A',
          claimedByUserId: 'claimant-1',
          claimedAt: claimedAtA,
        }),
        claimedConversationRow({
          id: 'conversation-B',
          claimedByUserId: 'claimant-1',
          claimedAt: claimedAtB,
        }),
      ]);
    const service = new IdentityMailboxSyncService(
      participantsRepository as never,
      { find: jest.fn() } as never,
      conversationsRepository as never,
      { staffUserIds: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );

    await service.onStaffRemoved('mailbox-A', 'claimant-1');

    const rows = rowsSnapshot();
    const conversationA = rows.find((row) => row.id === 'conversation-A');
    const conversationB = rows.find((row) => row.id === 'conversation-B');
    if (!conversationA || !conversationB) {
      throw new Error('Expected both conversation rows to still exist');
    }
    expect(conversationA.claimedByUserId).toBeNull();
    expect(conversationA.claimedAt).toBeNull();
    expect(conversationB.claimedByUserId).toBe('claimant-1');
    expect(conversationB.claimedAt).toEqual(claimedAtB);
  });

  it("also releases the claim through resyncMailbox's departed-user branch", async () => {
    const { repository: participantsRepository } =
      makeFakeParticipantsRepository([
        seatRow({
          userId: 'departed-owner',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
      ]);
    const claimedAt = new Date('2026-01-01T00:00:00Z');
    const { repository: conversationsRepository, rowsSnapshot } =
      makeFakeConversationsRepository([
        claimedConversationRow({
          id: 'conversation-1',
          claimedByUserId: 'departed-owner',
          claimedAt,
        }),
      ]);
    const identitiesService = {
      // Nobody is staff any more, so `departed-owner` falls out on this run.
      staffUserIds: jest.fn().mockResolvedValue([]),
    };
    const service = new IdentityMailboxSyncService(
      participantsRepository as never,
      { find: jest.fn() } as never,
      conversationsRepository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncMailbox('mailbox-A');

    const [conversation] = rowsSnapshot();
    if (!conversation) {
      throw new Error('Expected the conversation row to still exist');
    }
    expect(conversation.claimedByUserId).toBeNull();
    expect(conversation.claimedAt).toBeNull();
  });
});

// --- The sweep ---------------------------------------------------------------
//
// Each identity runs in its own transaction. The stand-in transaction hands
// the work a manager over the same stateful fakes, records whether a call
// happened inside it, and puts the seat rows back when the work throws, the
// way a rollback would.

function buildSweep(
  pageIdentities: { id: string; kind: IdentityKind }[],
  seeds: FakeParticipantRow[] = [],
) {
  const identitiesRepository = {
    find: jest.fn().mockResolvedValue(pageIdentities),
  };
  const participantsFake = makeFakeParticipantsRepository(seeds);
  const conversationsFake = makeFakeConversationsRepository([]);
  const transactionManager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === ConversationParticipant
        ? participantsFake.repository
        : conversationsFake.repository,
    ),
  };
  let isInsideTransaction = false;
  const transaction = jest.fn(
    async (work: (manager: typeof transactionManager) => Promise<unknown>) => {
      const savedRows = participantsFake.rowsSnapshot();
      isInsideTransaction = true;
      try {
        return await work(transactionManager);
      } catch (error) {
        participantsFake.replaceRows(savedRows);
        throw error;
      } finally {
        isInsideTransaction = false;
      }
    },
  );
  const participants = Object.assign(participantsFake.repository, {
    manager: { transaction },
  });
  const identitiesService = { staffUserIds: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const service = new IdentityMailboxSyncService(
    participants as never,
    identitiesRepository as never,
    conversationsFake.repository as never,
    identitiesService as never,
    eventEmitter as never,
  );
  const loggerError = jest
    .spyOn(
      (service as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    )
    .mockImplementation(() => undefined);
  return {
    service,
    identitiesRepository,
    identitiesService,
    transaction,
    transactionManager,
    eventEmitter,
    loggerError,
    participantsRepository: participantsFake.repository,
    conversationsRepository: conversationsFake.repository,
    rowsSnapshot: participantsFake.rowsSnapshot,
    isInsideTransaction: () => isInsideTransaction,
  };
}

describe('IdentityMailboxSyncService.resyncNonProfileIdentitiesPage', () => {
  it('reconciles every non-profile identity in the page and reports the cursor', async () => {
    const { service, identitiesService, transactionManager, transaction } =
      buildSweep([
        { id: 'identity-1', kind: IdentityKind.Listing },
        { id: 'identity-2', kind: IdentityKind.Subprofile },
      ]);
    identitiesService.staffUserIds.mockResolvedValue([]);

    const result = await service.resyncNonProfileIdentitiesPage();

    expect(transaction).toHaveBeenCalledTimes(2);
    for (const identityId of ['identity-1', 'identity-2']) {
      expect(identitiesService.staffUserIds).toHaveBeenCalledWith(identityId, {
        manager: transactionManager,
        shouldLockStaffSource: true,
      });
    }
    expect(result).toEqual({
      processedIdentityCount: 2,
      failedIdentityCount: 0,
      seatedMemberCount: 0,
      endedSeatCount: 0,
      lastIdentityId: 'identity-2',
      hasMoreIdentities: false,
    });
  });

  it('reports a null cursor once the page comes back empty', async () => {
    const { service, identitiesService, transaction } = buildSweep([]);

    const result = await service.resyncNonProfileIdentitiesPage('identity-2');

    expect(result).toEqual({
      processedIdentityCount: 0,
      failedIdentityCount: 0,
      seatedMemberCount: 0,
      endedSeatCount: 0,
      lastIdentityId: null,
      hasMoreIdentities: false,
    });
    expect(identitiesService.staffUserIds).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reads the staff source under its lock inside the transaction, before the seats', async () => {
    const {
      service,
      identitiesService,
      participantsRepository,
      isInsideTransaction,
    } = buildSweep([{ id: 'identity-1', kind: IdentityKind.Listing }]);
    const staffReadInsideTransaction: boolean[] = [];
    identitiesService.staffUserIds.mockImplementation(() => {
      staffReadInsideTransaction.push(isInsideTransaction());
      return Promise.resolve([]);
    });

    await service.resyncNonProfileIdentitiesPage();

    expect(staffReadInsideTransaction).toEqual([true]);
    const [, staffReadOptions] = identitiesService.staffUserIds.mock
      .calls[0] as [string, { shouldLockStaffSource?: boolean }];
    expect(staffReadOptions.shouldLockStaffSource).toBe(true);
    const staffReadOrder =
      identitiesService.staffUserIds.mock.invocationCallOrder[0] ?? 0;
    const firstSeatReadOrder =
      participantsRepository.find.mock.invocationCallOrder[0] ?? 0;
    expect(staffReadOrder).toBeLessThan(firstSeatReadOrder);
  });

  it('rolls back a failing identity, emits nothing for it, and reconciles the next one', async () => {
    const {
      service,
      identitiesService,
      conversationsRepository,
      eventEmitter,
      loggerError,
      rowsSnapshot,
    } = buildSweep(
      [
        { id: 'identity-1', kind: IdentityKind.Listing },
        { id: 'identity-2', kind: IdentityKind.Subprofile },
      ],
      [
        seatRow({
          identityId: 'identity-1',
          userId: 'departed-one',
          conversationId: 'conversation-1',
        }),
        seatRow({
          identityId: 'identity-2',
          userId: 'departed-two',
          conversationId: 'conversation-2',
        }),
      ],
    );
    identitiesService.staffUserIds.mockResolvedValue([]);
    // Identity 1 fails after its seat was already ended in the transaction:
    // the claim release that follows throws.
    conversationsRepository.createQueryBuilder.mockImplementationOnce(() => {
      throw new Error('claim release failed');
    });

    const result = await service.resyncNonProfileIdentitiesPage();

    const rows = rowsSnapshot();
    // Rolled back: identity 1's departed member still holds the seat the
    // failed transaction had ended, and the next sweep retries it.
    expect(
      rows.find((row) => row.userId === 'departed-one')?.leftAt,
    ).toBeNull();
    // Identity 2 was still reconciled.
    expect(
      rows.find((row) => row.userId === 'departed-two')?.leftAt,
    ).toBeInstanceOf(Date);
    const emittedUserIds = eventEmitter.emit.mock.calls.map(
      ([, payload]) =>
        (payload as { userIds?: string[]; userId?: string }).userIds?.[0] ??
        (payload as { userId?: string }).userId,
    );
    expect(emittedUserIds).not.toContain('departed-one');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: 'conversation-2', userIds: ['departed-two'] },
    );
    expect(result).toEqual({
      processedIdentityCount: 2,
      failedIdentityCount: 1,
      seatedMemberCount: 0,
      endedSeatCount: 1,
      lastIdentityId: 'identity-2',
      hasMoreIdentities: false,
    });
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]?.[0]).toContain('identity-1');
  });

  it("emits an identity's changes only after its transaction resolves", async () => {
    const { service, identitiesService, eventEmitter, isInsideTransaction } =
      buildSweep(
        [{ id: 'identity-1', kind: IdentityKind.Listing }],
        [
          seatRow({
            identityId: 'identity-1',
            userId: 'departed',
            conversationId: 'conversation-1',
          }),
        ],
      );
    identitiesService.staffUserIds.mockResolvedValue([]);
    const emittedInsideTransaction: boolean[] = [];
    eventEmitter.emit.mockImplementation(() => {
      emittedInsideTransaction.push(isInsideTransaction());
      return true;
    });

    await service.resyncNonProfileIdentitiesPage();

    expect(emittedInsideTransaction.length).toBeGreaterThan(0);
    expect(emittedInsideTransaction.every((isInside) => !isInside)).toBe(true);
  });

  it('counts the members it seats and the seats it ends, flooring each new seat at the database clock read inside the transaction', async () => {
    const {
      service,
      identitiesService,
      participantsRepository,
      isInsideTransaction,
      rowsSnapshot,
    } = buildSweep(
      [{ id: 'identity-1', kind: IdentityKind.Listing }],
      [
        seatRow({
          identityId: 'identity-1',
          userId: 'owner',
          conversationId: 'conversation-1',
        }),
        seatRow({
          identityId: 'identity-1',
          userId: 'departed',
          conversationId: 'conversation-1',
        }),
        seatRow({
          identityId: 'identity-1',
          userId: 'departed',
          conversationId: 'conversation-2',
        }),
        seatRow({
          identityId: 'identity-1',
          userId: 'owner',
          conversationId: 'conversation-2',
        }),
      ],
    );
    identitiesService.staffUserIds.mockResolvedValue(['owner', 'missing']);
    const clockReadInsideTransaction: boolean[] = [];
    participantsRepository.query.mockImplementation((sql: string) => {
      if (!sql.includes('clock_timestamp()')) {
        throw new Error(`Unmodelled query: ${sql}`);
      }
      clockReadInsideTransaction.push(isInsideTransaction());
      return Promise.resolve([{ floorInstant: DATABASE_NOW }]);
    });

    const result = await service.resyncNonProfileIdentitiesPage();

    expect(result.seatedMemberCount).toBe(1);
    expect(result.endedSeatCount).toBe(2);
    expect(result.failedIdentityCount).toBe(0);
    // Task 1: one clock read, taken inside the identity's transaction, after
    // the staff locks, and both columns of every new seat carry it.
    expect(clockReadInsideTransaction).toEqual([true]);
    const missingRows = rowsSnapshot().filter(
      (row) => row.userId === 'missing',
    );
    expect(missingRows).toHaveLength(2);
    for (const missingRow of missingRows) {
      expect(missingRow.clearedAt).toEqual(DATABASE_NOW);
      expect(missingRow.historyFloorAt).toEqual(DATABASE_NOW);
    }
  });

  it('pages only mailboxes that hold a seat row, keeping the keyset cursor on the id', async () => {
    const { service, identitiesRepository, identitiesService } = buildSweep([]);
    identitiesService.staffUserIds.mockResolvedValue([]);
    type RawIdOperator = {
      type: string;
      getSql: (column: string) => string;
      objectLiteralParameters: Record<string, unknown> | undefined;
    };
    const idOperatorOfCall = (callIndex: number): RawIdOperator =>
      (
        identitiesRepository.find.mock.calls[callIndex] as [
          { where: { id: RawIdOperator } },
        ]
      )[0].where.id;

    await service.resyncNonProfileIdentitiesPage();
    await service.resyncNonProfileIdentitiesPage('identity-2');

    const firstPageId = idOperatorOfCall(0);
    expect(firstPageId.type).toBe('raw');
    expect(firstPageId.getSql('"identity"."id"')).toBe(
      'EXISTS (SELECT 1 FROM "conversation_participants" "sweep_seat" ' +
        'WHERE "sweep_seat"."identity_id" = "identity"."id")',
    );
    const laterPageId = idOperatorOfCall(1);
    expect(laterPageId.getSql('"identity"."id"')).toBe(
      'EXISTS (SELECT 1 FROM "conversation_participants" "sweep_seat" ' +
        'WHERE "sweep_seat"."identity_id" = "identity"."id") ' +
        'AND "identity"."id" > :afterIdentityId',
    );
    expect(laterPageId.objectLiteralParameters).toEqual({
      afterIdentityId: 'identity-2',
    });
  });

  it('reports more identities when the page comes back full, and none when it comes back short', async () => {
    const fullPage = buildSweep([
      { id: 'identity-1', kind: IdentityKind.Listing },
      { id: 'identity-2', kind: IdentityKind.Listing },
    ]);
    fullPage.identitiesService.staffUserIds.mockResolvedValue([]);
    const fullResult = await fullPage.service.resyncNonProfileIdentitiesPage(
      null,
      2,
    );
    expect(fullResult.hasMoreIdentities).toBe(true);
    expect(fullResult.lastIdentityId).toBe('identity-2');
    expect(fullPage.identitiesRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, order: { id: 'ASC' } }),
    );

    const shortPage = buildSweep([
      { id: 'identity-3', kind: IdentityKind.Listing },
    ]);
    shortPage.identitiesService.staffUserIds.mockResolvedValue([]);
    const shortResult = await shortPage.service.resyncNonProfileIdentitiesPage(
      'identity-2',
      2,
    );
    expect(shortResult.hasMoreIdentities).toBe(false);
    expect(shortResult.lastIdentityId).toBe('identity-3');
  });

  it('moves the cursor past a failed last identity, so the next page does not retry it forever', async () => {
    const { service, identitiesService } = buildSweep([
      { id: 'identity-1', kind: IdentityKind.Listing },
      { id: 'identity-2', kind: IdentityKind.Listing },
    ]);
    identitiesService.staffUserIds.mockImplementation(
      async (identityId: string) => {
        if (identityId === 'identity-2') {
          throw new Error('staff lookup failed');
        }
        return [];
      },
    );

    const result = await service.resyncNonProfileIdentitiesPage(null, 2);

    expect(result.lastIdentityId).toBe('identity-2');
    expect(result.hasMoreIdentities).toBe(true);
    expect(result.failedIdentityCount).toBe(1);
  });
});

// --- Concern 1 (fix round 1): the staff set is read in the caller's transaction

describe('IdentityMailboxSyncService.resyncMailbox reads staff through the given manager', () => {
  it('passes the manager to the staff read, so an uncommitted transfer is seen', async () => {
    const { repository } = makeFakeParticipantsRepository([
      seatRow({ userId: 'previous-owner', identityId: 'listing-identity' }),
    ]);
    const conversationsRepository = makeFakeConversationsRepository(
      [],
    ).repository;
    const transactionManager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === ConversationParticipant
          ? repository
          : conversationsRepository,
      ),
    };
    // Answers as the transaction sees it: the new owner, and the previous
    // owner gone. A read on its own pool connection would still see the
    // previous owner.
    const identitiesService = {
      staffUserIds: jest.fn(
        (_identityId: string, options?: { manager?: unknown }) =>
          Promise.resolve(
            options?.manager === transactionManager
              ? ['new-owner']
              : ['previous-owner'],
          ),
      ),
    };
    const service = new IdentityMailboxSyncService(
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { createQueryBuilder: jest.fn() } as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    const changes = await service.resyncMailbox(
      'listing-identity',
      transactionManager as never,
      { shouldDeferEmission: true },
    );

    expect(identitiesService.staffUserIds).toHaveBeenCalledWith(
      'listing-identity',
      { manager: transactionManager, shouldLockStaffSource: false },
    );
    expect(changes.endedSeats).toEqual([
      { conversationId: 'conversation-1', userId: 'previous-owner' },
    ]);
    expect(changes.staffingChanges).toContainEqual({
      identityId: 'listing-identity',
      userId: 'new-owner',
      isStaff: true,
    });
  });

  it('keeps the plain one-argument staff read when no manager is given', async () => {
    const { repository } = makeFakeParticipantsRepository([]);
    const identitiesService = { staffUserIds: jest.fn().mockResolvedValue([]) };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      identitiesService as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncMailbox('listing-identity');

    expect(identitiesService.staffUserIds).toHaveBeenCalledWith(
      'listing-identity',
    );
    expect(identitiesService.staffUserIds.mock.calls[0]).toHaveLength(1);
  });
});

// --- Task 14a: a departing staff member's live sockets leave the mailbox ----
//
// A departed staff seat has no access to the mailbox, and every live frame
// after a socket's join is a room emit, so ending the seats tells
// `ChatGateway` (through `CONVERSATION_MEMBERSHIP_REVOKED`, the event it
// already answers for a group removal) to make that one user's sockets
// leave each of those rooms and no other.
describe('IdentityMailboxSyncService evicts a departing staff member from the live rooms', () => {
  function buildWithSeats(seeds: FakeParticipantRow[]) {
    const { repository } = makeFakeParticipantsRepository(seeds);
    const eventEmitter = { emit: jest.fn() };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      { staffUserIds: jest.fn().mockResolvedValue(['colleague']) } as never,
      eventEmitter as never,
    );
    return { service, eventEmitter };
  }

  const seeds = () => [
    seatRow({
      userId: 'departing',
      conversationId: 'conversation-1',
      identityId: 'mailbox-A',
    }),
    seatRow({
      userId: 'departing',
      conversationId: 'conversation-2',
      identityId: 'mailbox-A',
    }),
    // Already ended earlier: no socket of theirs can still be in that room
    // on this seat's account, and nothing about it changes now.
    seatRow({
      userId: 'departing',
      conversationId: 'conversation-3',
      identityId: 'mailbox-A',
      leftAt: new Date('2026-01-01T00:00:00Z'),
    }),
    // Another mailbox they still work for.
    seatRow({
      userId: 'departing',
      conversationId: 'conversation-4',
      identityId: 'mailbox-B',
    }),
    seatRow({
      userId: 'colleague',
      conversationId: 'conversation-1',
      identityId: 'mailbox-A',
    }),
  ];

  it('revokes exactly the rooms of the threads whose seat this call ended, for that user alone', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());

    await service.onStaffRemoved('mailbox-A', 'departing');

    expect(
      eventEmitter.emit.mock.calls.filter(
        ([eventName]) => eventName === CONVERSATION_MEMBERSHIP_REVOKED,
      ),
    ).toEqual([
      [
        CONVERSATION_MEMBERSHIP_REVOKED,
        { conversationId: 'conversation-1', userIds: ['departing'] },
      ],
      [
        CONVERSATION_MEMBERSHIP_REVOKED,
        { conversationId: 'conversation-2', userIds: ['departing'] },
      ],
    ]);
  });

  it('revokes the same rooms when the resync finds the departure', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());

    await service.resyncMailbox('mailbox-A');

    expect(
      eventEmitter.emit.mock.calls
        .filter(([eventName]) => eventName === CONVERSATION_MEMBERSHIP_REVOKED)
        .map(
          ([, payload]) =>
            (payload as { conversationId: string }).conversationId,
        ),
    ).toEqual(['conversation-1', 'conversation-2']);
  });

  it('revokes nothing on a repeat call, since no seat is ended twice', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());

    await service.onStaffRemoved('mailbox-A', 'departing');
    eventEmitter.emit.mockClear();
    await service.onStaffRemoved('mailbox-A', 'departing');

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('never fails the seat write when the live relay throws', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());
    eventEmitter.emit.mockImplementation(() => {
      throw new Error('relay down');
    });

    await expect(
      service.onStaffRemoved('mailbox-A', 'departing'),
    ).resolves.toMatchObject({
      endedSeats: [
        { conversationId: 'conversation-1', userId: 'departing' },
        { conversationId: 'conversation-2', userId: 'departing' },
      ],
    });
  });
});

// --- CW-24: deferred emission for a caller that owns the transaction -------
//
// `onStaffRemoved`/`resyncMailbox` used to fire `CONVERSATION_MEMBERSHIP_
// REVOKED` synchronously, mid-write, so a caller's still-open transaction
// could roll the seat ending back after the event already went out. Passing
// `{ shouldDeferEmission: true }` (the option the three transactional
// callers now use) suppresses that immediate emission, and
// `emitMembershipRevoked` is the one place left that fires it, meant to be
// called by that caller only once its own `dataSource.transaction(...)` has
// resolved, mirroring `GroupsService.leaveGroup`'s post-commit fan-out.
describe('IdentityMailboxSyncService deferred emission (CW-24)', () => {
  function buildWithSeats(seeds: FakeParticipantRow[]) {
    const { repository } = makeFakeParticipantsRepository(seeds);
    const eventEmitter = { emit: jest.fn() };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      { staffUserIds: jest.fn().mockResolvedValue([]) } as never,
      eventEmitter as never,
    );
    return { service, eventEmitter };
  }

  const seeds = () => [
    seatRow({
      userId: 'departing',
      conversationId: 'conversation-1',
      identityId: 'mailbox-A',
    }),
  ];

  it('onStaffRemoved does not emit when told to defer, but still returns the ended seats', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());

    const changes = await service.onStaffRemoved(
      'mailbox-A',
      'departing',
      undefined,
      { shouldDeferEmission: true },
    );

    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(changes.endedSeats).toEqual([
      { conversationId: 'conversation-1', userId: 'departing' },
    ]);
  });

  it('resyncMailbox does not emit when told to defer, but still returns the ended seats', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());

    const changes = await service.resyncMailbox('mailbox-A', undefined, {
      shouldDeferEmission: true,
    });

    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(changes.endedSeats).toEqual([
      { conversationId: 'conversation-1', userId: 'departing' },
    ]);
  });

  it('emitMembershipRevoked fires exactly the deferred list, once called', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());
    const changes = await service.onStaffRemoved(
      'mailbox-A',
      'departing',
      undefined,
      { shouldDeferEmission: true },
    );

    service.emitMembershipRevoked(changes.endedSeats);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: 'conversation-1', userIds: ['departing'] },
    );
  });

  it('without shouldDeferEmission, onStaffRemoved still emits immediately, unchanged for existing callers', async () => {
    const { service, eventEmitter } = buildWithSeats(seeds());

    await service.onStaffRemoved('mailbox-A', 'departing');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: 'conversation-1', userIds: ['departing'] },
    );
  });
});

// --- Task 25: staffing changes and the system release of a departing claimant
//
// A member hears live when a call starts or ends their staff standing on a
// mailbox (`IDENTITY_STAFFING_CHANGED`), and colleagues hear each claim the
// system releases when a claimant leaves (`CONVERSATION_CLAIM_CHANGED` with
// a null actor). Both ride the same deferral contract as the room eviction.
describe('IdentityMailboxSyncService staffing changes (Task 25)', () => {
  function build(
    seeds: FakeParticipantRow[],
    staffUserIds: string[] = [],
    conversationSeeds: FakeConversationRow[] = [],
  ) {
    const { repository } = makeFakeParticipantsRepository(seeds);
    const conversations = makeFakeConversationsRepository(conversationSeeds);
    const eventEmitter = { emit: jest.fn() };
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      conversations.repository as never,
      { staffUserIds: jest.fn().mockResolvedValue(staffUserIds) } as never,
      eventEmitter as never,
    );
    const emitted = (eventName: string) =>
      eventEmitter.emit.mock.calls
        .filter(([emittedName]) => emittedName === eventName)
        .map(([, payload]) => payload as unknown);
    return {
      service,
      eventEmitter,
      emitted,
      conversationRows: conversations.rowsSnapshot,
    };
  }

  const twoThreadMailbox = () => [
    seatRow({
      userId: 'owner',
      conversationId: 'conversation-1',
      identityId: 'mailbox-A',
    }),
    seatRow({
      userId: 'owner',
      conversationId: 'conversation-2',
      identityId: 'mailbox-A',
    }),
  ];

  it('onStaffAdded tells a new co-manager once, and a repeat call tells nobody', async () => {
    const { service, emitted, eventEmitter } = build(twoThreadMailbox());

    const changes = await service.onStaffAdded('mailbox-A', 'new-staff');

    expect(changes.staffingChanges).toEqual([
      { identityId: 'mailbox-A', userId: 'new-staff', isStaff: true },
    ]);
    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual([
      { identityId: 'mailbox-A', userId: 'new-staff', isStaff: true },
    ]);

    eventEmitter.emit.mockClear();
    const repeat = await service.onStaffAdded('mailbox-A', 'new-staff');

    expect(repeat.staffingChanges).toEqual([]);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('onStaffAdded tells a member who joined a mailbox with no threads yet', async () => {
    const { service, emitted } = build([]);

    await service.onStaffAdded('mailbox-A', 'new-staff');

    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual([
      { identityId: 'mailbox-A', userId: 'new-staff', isStaff: true },
    ]);
  });

  it('onStaffAdded tells a returning member whose old seats it reactivated', async () => {
    const { service, emitted } = build([
      ...twoThreadMailbox(),
      seatRow({
        userId: 'returning',
        conversationId: 'conversation-1',
        identityId: 'mailbox-A',
        leftAt: new Date('2026-01-01T00:00:00Z'),
      }),
      seatRow({
        userId: 'returning',
        conversationId: 'conversation-2',
        identityId: 'mailbox-A',
        leftAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ]);

    await service.onStaffAdded('mailbox-A', 'returning');

    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual([
      { identityId: 'mailbox-A', userId: 'returning', isStaff: true },
    ]);
  });

  it('onStaffRemoved tells the departing member once, and a repeat call tells nobody', async () => {
    const { service, emitted, eventEmitter } = build([
      ...twoThreadMailbox(),
      seatRow({
        userId: 'departing',
        conversationId: 'conversation-1',
        identityId: 'mailbox-A',
      }),
    ]);

    await service.onStaffRemoved('mailbox-A', 'departing');

    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual([
      { identityId: 'mailbox-A', userId: 'departing', isStaff: false },
    ]);

    eventEmitter.emit.mockClear();
    await service.onStaffRemoved('mailbox-A', 'departing');

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('onStaffRemoved tells a member who left a mailbox with no threads yet', async () => {
    const { service, emitted } = build([]);

    await service.onStaffRemoved('mailbox-A', 'departing');

    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual([
      { identityId: 'mailbox-A', userId: 'departing', isStaff: false },
    ]);
  });

  it('resyncMailbox reports one change per member it seated and per member it unseated', async () => {
    const { service, emitted } = build(
      [
        ...twoThreadMailbox(),
        seatRow({
          userId: 'departed',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
      ],
      ['owner', 'new-comanager'],
    );

    const changes = await service.resyncMailbox('mailbox-A');

    expect(changes.staffingChanges).toEqual([
      { identityId: 'mailbox-A', userId: 'new-comanager', isStaff: true },
      { identityId: 'mailbox-A', userId: 'departed', isStaff: false },
    ]);
    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual(changes.staffingChanges);
  });

  it('resyncMailbox reports nothing when it changes nothing, including on a mailbox with no threads', async () => {
    const { service, eventEmitter } = build(twoThreadMailbox(), ['owner']);

    await service.resyncMailbox('mailbox-A');

    expect(eventEmitter.emit).not.toHaveBeenCalled();

    const empty = build([], ['owner', 'colleague']);
    const changes = await empty.service.resyncMailbox('mailbox-A');

    expect(changes.staffingChanges).toEqual([]);
    expect(empty.eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('defers every staffing change until emitStaffingChanged receives the returned list', async () => {
    const { service, eventEmitter, emitted } = build(twoThreadMailbox());

    const added = await service.onStaffAdded(
      'mailbox-A',
      'new-staff',
      undefined,
      { shouldDeferEmission: true },
    );
    const removed = await service.onStaffRemoved(
      'mailbox-A',
      'owner',
      undefined,
      { shouldDeferEmission: true },
    );

    expect(eventEmitter.emit).not.toHaveBeenCalled();

    service.emitStaffingChanged([
      ...added.staffingChanges,
      ...removed.staffingChanges,
    ]);

    expect(emitted(IDENTITY_STAFFING_CHANGED)).toEqual([
      { identityId: 'mailbox-A', userId: 'new-staff', isStaff: true },
      { identityId: 'mailbox-A', userId: 'owner', isStaff: false },
    ]);
  });

  it('records a system release and tells colleagues once per released thread, with no actor', async () => {
    const claimedAt = new Date('2026-01-01T00:00:00Z');
    const { service, emitted, eventEmitter, conversationRows } = build(
      [
        ...twoThreadMailbox(),
        seatRow({
          userId: 'claimant',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
        seatRow({
          userId: 'claimant',
          conversationId: 'conversation-2',
          identityId: 'mailbox-A',
        }),
      ],
      [],
      [
        claimedConversationRow({
          id: 'conversation-1',
          claimedByUserId: 'claimant',
          claimedAt,
          claimReleasedByUserId: 'owner',
          claimReleasedAt: claimedAt,
        }),
        claimedConversationRow({
          id: 'conversation-2',
          claimedByUserId: 'owner',
          claimedAt,
        }),
      ],
    );

    const changes = await service.onStaffRemoved(
      'mailbox-A',
      'claimant',
      undefined,
      { shouldDeferEmission: true },
    );

    expect(eventEmitter.emit).not.toHaveBeenCalled();
    const [released, untouched] = conversationRows();
    expect(released).toMatchObject({
      claimedByUserId: null,
      claimedAt: null,
      claimReleasedByUserId: null,
      claimTakenOverFromUserId: null,
    });
    expect(released?.claimReleasedAt).toBeInstanceOf(Date);
    expect(released?.claimReleasedAt).not.toEqual(claimedAt);
    expect(untouched).toMatchObject({ claimedByUserId: 'owner', claimedAt });

    service.emitSeatChanges(changes);

    expect(emitted(CONVERSATION_CLAIM_CHANGED)).toEqual([
      {
        conversationId: 'conversation-1',
        mailboxIdentityId: 'mailbox-A',
        change: 'released',
        isImplicit: false,
        actorUserId: null,
        claimedByUserId: null,
        previousClaimantUserId: 'claimant',
        changedAt: released?.claimReleasedAt,
      },
    ]);
    // The room eviction goes out first, so the departed member's sockets
    // have left before colleagues hear the release.
    expect(
      eventEmitter.emit.mock.calls.map(([eventName]) => eventName as string),
    ).toEqual([
      CONVERSATION_MEMBERSHIP_REVOKED,
      CONVERSATION_MEMBERSHIP_REVOKED,
      CONVERSATION_CLAIM_CHANGED,
      IDENTITY_STAFFING_CHANGED,
    ]);
  });

  it('clears the take-over when a claimant who took a thread over then leaves', async () => {
    const claimedAt = new Date('2026-01-01T00:00:00Z');
    const { service, emitted, conversationRows } = build(
      [
        seatRow({
          userId: 'new-claimant',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
        seatRow({
          userId: 'ana',
          conversationId: 'conversation-1',
          identityId: 'mailbox-A',
        }),
      ],
      ['ana'],
      [
        claimedConversationRow({
          id: 'conversation-1',
          claimedByUserId: 'new-claimant',
          claimedAt,
          claimTakenOverFromUserId: 'ana',
        }),
      ],
    );

    await service.resyncMailbox('mailbox-A');

    expect(conversationRows()[0]).toMatchObject({
      claimedByUserId: null,
      claimReleasedByUserId: null,
      claimTakenOverFromUserId: null,
    });
    expect(emitted(CONVERSATION_CLAIM_CHANGED)).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-1',
        actorUserId: null,
        previousClaimantUserId: 'new-claimant',
      }),
    ]);
  });

  it('resyncConversation records the same system release on its one thread', async () => {
    const claimedAt = new Date('2026-01-01T00:00:00Z');
    const { repository } = makeFakeParticipantsRepository([
      seatRow({
        userId: 'new-claimant',
        conversationId: 'conversation-1',
        identityId: 'mailbox-A',
      }),
    ]);
    const conversations = makeFakeConversationsRepository([
      claimedConversationRow({
        id: 'conversation-1',
        claimedByUserId: 'new-claimant',
        claimedAt,
        claimTakenOverFromUserId: 'ana',
      }),
    ]);
    const service = new IdentityMailboxSyncService(
      repository as never,
      { find: jest.fn() } as never,
      conversations.repository as never,
      { staffUserIds: jest.fn().mockResolvedValue(['ana']) } as never,
      { emit: jest.fn() } as never,
    );

    await service.resyncConversation('mailbox-A', 'conversation-1');

    const [conversation] = conversations.rowsSnapshot();
    expect(conversation).toMatchObject({
      claimedByUserId: null,
      claimedAt: null,
      claimReleasedByUserId: null,
      claimTakenOverFromUserId: null,
    });
    expect(conversation?.claimReleasedAt).toBeInstanceOf(Date);
  });
});

// F2 (I1): a member who once wrote to the business already holds a customer
// seat, under their own profile identity, in that thread. There is one seat
// per (conversation, user), so when they become staff that thread keeps the
// customer seat, they are staffed in every other thread, and the insert that
// used to collide with `UQ_conversation_participants` never happens.
describe('IdentityMailboxSyncService, a former customer who becomes staff', () => {
  const CUSTOMER_IDENTITY = 'customer-profile-identity';

  function build(seeds: FakeParticipantRow[], staffUserIds: string[] = []) {
    const participants = makeFakeParticipantsRepository(seeds);
    const eventEmitter = { emit: jest.fn() };
    const service = new IdentityMailboxSyncService(
      participants.repository as never,
      { find: jest.fn() } as never,
      makeFakeConversationsRepository([]).repository as never,
      { staffUserIds: jest.fn().mockResolvedValue(staffUserIds) } as never,
      eventEmitter as never,
    );
    return { service, participants };
  }

  /** The owner staffs two threads; `former-customer` is the customer of the
   *  first one. */
  const mailboxWithTheirOwnThread = () => [
    seatRow({ userId: 'owner', conversationId: 'their-own-thread' }),
    seatRow({
      userId: 'former-customer',
      conversationId: 'their-own-thread',
      identityId: CUSTOMER_IDENTITY,
    }),
    seatRow({ userId: 'owner', conversationId: 'another-thread' }),
    seatRow({
      userId: 'someone-else',
      conversationId: 'another-thread',
      identityId: 'someone-else-identity',
    }),
  ];

  const seatsOf = (rows: FakeParticipantRow[], userId: string) =>
    rows
      .filter((row) => row.userId === userId)
      .map((row) => ({
        conversationId: row.conversationId,
        identityId: row.identityId,
        isActive: row.leftAt === null,
      }))
      .sort((left, right) =>
        left.conversationId.localeCompare(right.conversationId),
      );

  it('onStaffAdded keeps their customer seat and staffs them in every other thread', async () => {
    const { service, participants } = build(mailboxWithTheirOwnThread());

    const changes = await service.onStaffAdded(
      'business-identity',
      'former-customer',
    );

    expect(seatsOf(participants.rowsSnapshot(), 'former-customer')).toEqual([
      {
        conversationId: 'another-thread',
        identityId: 'business-identity',
        isActive: true,
      },
      {
        conversationId: 'their-own-thread',
        identityId: CUSTOMER_IDENTITY,
        isActive: true,
      },
    ]);
    expect(changes.staffingChanges).toEqual([
      {
        identityId: 'business-identity',
        userId: 'former-customer',
        isStaff: true,
      },
    ]);
  });

  it('onStaffAdded still reports the new staff standing when their own thread is the only one', async () => {
    const { service, participants } = build([
      seatRow({ userId: 'owner', conversationId: 'their-own-thread' }),
      seatRow({
        userId: 'former-customer',
        conversationId: 'their-own-thread',
        identityId: CUSTOMER_IDENTITY,
      }),
    ]);

    const changes = await service.onStaffAdded(
      'business-identity',
      'former-customer',
    );

    expect(participants.repository.save).not.toHaveBeenCalled();
    expect(changes.staffingChanges).toEqual([
      {
        identityId: 'business-identity',
        userId: 'former-customer',
        isStaff: true,
      },
    ]);
  });

  it('resyncMailbox, the ownership-transfer and claim path, seats them the same way and repeats as a no-op', async () => {
    const { service, participants } = build(mailboxWithTheirOwnThread(), [
      'owner',
      'former-customer',
    ]);

    const first = await service.resyncMailbox('business-identity');
    const second = await service.resyncMailbox('business-identity');

    expect(seatsOf(participants.rowsSnapshot(), 'former-customer')).toEqual([
      {
        conversationId: 'another-thread',
        identityId: 'business-identity',
        isActive: true,
      },
      {
        conversationId: 'their-own-thread',
        identityId: CUSTOMER_IDENTITY,
        isActive: true,
      },
    ]);
    expect(first.staffingChanges).toEqual([
      {
        identityId: 'business-identity',
        userId: 'former-customer',
        isStaff: true,
      },
    ]);
    expect(second.staffingChanges).toEqual([]);
    expect(second.endedSeats).toEqual([]);
  });

  it('onStaffRemoved ends their staff seats and leaves the customer seat active', async () => {
    const { service, participants } = build(mailboxWithTheirOwnThread());
    await service.onStaffAdded('business-identity', 'former-customer');

    const changes = await service.onStaffRemoved(
      'business-identity',
      'former-customer',
    );

    expect(changes.endedSeats).toEqual([
      { conversationId: 'another-thread', userId: 'former-customer' },
    ]);
    expect(seatsOf(participants.rowsSnapshot(), 'former-customer')).toEqual([
      {
        conversationId: 'another-thread',
        identityId: 'business-identity',
        isActive: false,
      },
      {
        conversationId: 'their-own-thread',
        identityId: CUSTOMER_IDENTITY,
        isActive: true,
      },
    ]);
  });
});

// --- Final review C1: a persona creator who left stays departed -------------
//
// `SubprofileMembershipService.leave` deletes a departing creator's roster
// row and keeps `subprofiles.user_id`. Here the REAL `IdentitiesService`
// answers the staff read, through the sweep's own transaction and lock, so
// these tests fail if that column counts as staff again.

const PERSONA_IDENTITY = 'persona-identity';

function buildPersonaSweep(seeds: FakeParticipantRow[]) {
  const participantsFake = makeFakeParticipantsRepository(seeds);
  const conversationsFake = makeFakeConversationsRepository([]);
  const repositories = new Map<unknown, unknown>([
    [ConversationParticipant, participantsFake.repository],
    [Conversation, conversationsFake.repository],
    [
      Identity,
      {
        findOne: jest.fn().mockResolvedValue({
          id: PERSONA_IDENTITY,
          kind: IdentityKind.Subprofile,
          subprofileId: 'persona-1',
        }),
      },
    ],
    [
      Subprofile,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'persona-1', userId: 'departed-creator' }),
      },
    ],
    [
      SubprofileMember,
      { find: jest.fn().mockResolvedValue([{ userId: 'coowner-user' }]) },
    ],
  ]);
  const transactionManager = {
    getRepository: jest.fn((entity: unknown) => {
      const repository = repositories.get(entity);
      if (!repository) {
        throw new Error('Unmodelled repository');
      }
      return repository;
    }),
  };
  const participants = Object.assign(participantsFake.repository, {
    manager: {
      transaction: jest.fn(
        (work: (manager: typeof transactionManager) => Promise<unknown>) =>
          work(transactionManager),
      ),
    },
  });
  // Every staff source is read through the transaction manager, so the
  // injected repositories are never reached.
  const identitiesService = new IdentitiesService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const eventEmitter = { emit: jest.fn() };
  const service = new IdentityMailboxSyncService(
    participants as never,
    {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: PERSONA_IDENTITY, kind: IdentityKind.Subprofile },
        ]),
    } as never,
    conversationsFake.repository as never,
    identitiesService,
    eventEmitter as never,
  );
  return {
    service,
    eventEmitter,
    transactionManager,
    rowsSnapshot: participantsFake.rowsSnapshot,
  };
}

describe('IdentityMailboxSyncService, a persona creator who left the roster', () => {
  const leftAt = new Date('2026-09-01T00:00:00Z');

  it('the hourly sweep leaves their ended seats ended and announces nothing for them', async () => {
    const { service, eventEmitter, rowsSnapshot } = buildPersonaSweep([
      seatRow({
        identityId: PERSONA_IDENTITY,
        userId: 'departed-creator',
        conversationId: 'conversation-1',
        leftAt,
      }),
      seatRow({
        identityId: PERSONA_IDENTITY,
        userId: 'coowner-user',
        conversationId: 'conversation-1',
      }),
    ]);

    const result = await service.resyncNonProfileIdentitiesPage();

    expect(result).toEqual(
      expect.objectContaining({
        failedIdentityCount: 0,
        seatedMemberCount: 0,
        endedSeatCount: 0,
      }),
    );
    expect(
      rowsSnapshot().find((row) => row.userId === 'departed-creator'),
    ).toEqual(expect.objectContaining({ leftAt, historyFloorAt: null }));
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      IDENTITY_STAFFING_CHANGED,
      expect.objectContaining({ userId: 'departed-creator', isStaff: true }),
    );
  });

  it('resyncMailbox ends a seat they still hold and does not reactivate it on the next run', async () => {
    const { service, transactionManager, rowsSnapshot } = buildPersonaSweep([
      seatRow({
        identityId: PERSONA_IDENTITY,
        userId: 'departed-creator',
        conversationId: 'conversation-1',
      }),
      seatRow({
        identityId: PERSONA_IDENTITY,
        userId: 'coowner-user',
        conversationId: 'conversation-1',
      }),
    ]);

    const firstRun = await service.resyncMailbox(
      PERSONA_IDENTITY,
      transactionManager as never,
      { shouldDeferEmission: true, shouldLockStaffSource: true },
    );
    const endedAt = rowsSnapshot().find(
      (row) => row.userId === 'departed-creator',
    )?.leftAt;
    const secondRun = await service.resyncMailbox(
      PERSONA_IDENTITY,
      transactionManager as never,
      { shouldDeferEmission: true, shouldLockStaffSource: true },
    );

    expect(firstRun.endedSeats).toEqual([
      { conversationId: 'conversation-1', userId: 'departed-creator' },
    ]);
    expect(endedAt).toBeInstanceOf(Date);
    expect(secondRun.staffingChanges).toEqual([]);
    expect(
      rowsSnapshot().find((row) => row.userId === 'departed-creator')?.leftAt,
    ).toEqual(endedAt);
  });
});
