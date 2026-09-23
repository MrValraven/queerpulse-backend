import { CONVERSATION_CLAIM_CHANGED } from '../messaging/conversation-claim';
import { CONVERSATION_MEMBERSHIP_REVOKED } from '../messaging/messaging.events';
import { IdentityMailboxSyncService } from './identity-mailbox-sync.service';

/**
 * Task 18 fix round 1: `IdentityMailboxSyncService.resyncConversation`, the
 * seat sync for the one thread a customer's enquiry is reusing. An
 * in-memory seat table stands in for the repository, so each test reads the
 * rows the method leaves behind.
 */

interface Seat {
  conversationId: string;
  userId: string;
  identityId: string;
  leftAt: Date | null;
  clearedAt: Date | null;
}

interface ConversationRow {
  id: string;
  claimedByUserId: string | null;
  claimedAt: Date | null;
}

function isIsNull(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'isNull'
  );
}

function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = (row as Record<string, unknown>)[key];
    return isIsNull(expected) ? actual === null : actual === expected;
  });
}

const MAILBOX = 'business-identity';
const THREAD = 'this-thread';
const EARLIER = new Date('2026-09-01T10:00:00Z');

function makeService(options: {
  staff: string[];
  seats: Seat[];
  conversations?: ConversationRow[];
}) {
  const seats = options.seats.map((seat) => ({ ...seat }));
  const conversationRows = (
    options.conversations ?? [
      { id: THREAD, claimedByUserId: null, claimedAt: null },
    ]
  ).map((conversation) => ({ ...conversation }));
  const participants = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(seats.filter((seat) => matches(seat, where))),
    ),
    create: jest.fn((row: Partial<Seat>) => ({
      leftAt: null,
      clearedAt: null,
      ...row,
    })),
    save: jest.fn((rows: Seat[]) => {
      seats.push(...rows);
      return Promise.resolve(rows);
    }),
    update: jest.fn(
      (where: Record<string, unknown>, changes: Partial<Seat>) => {
        const matched = seats.filter((seat) => matches(seat, where));
        matched.forEach((seat) => Object.assign(seat, changes));
        return Promise.resolve({ affected: matched.length });
      },
    ),
  };
  const conversations = {
    update: jest.fn(
      (where: Record<string, unknown>, changes: Partial<ConversationRow>) => {
        const matched = conversationRows.filter((row) => matches(row, where));
        matched.forEach((row) => Object.assign(row, changes));
        return Promise.resolve({ affected: matched.length });
      },
    ),
  };
  const eventEmitter = { emit: jest.fn() };
  const service = new IdentityMailboxSyncService(
    participants as never,
    {} as never,
    conversations as never,
    {
      staffUserIds: jest.fn(() => Promise.resolve(options.staff)),
    } as never,
    eventEmitter as never,
  );
  return { service, seats, conversationRows, eventEmitter, participants };
}

function seat(
  userId: string,
  overrides: Partial<Seat> = {},
  conversationId = THREAD,
): Seat {
  return {
    conversationId,
    userId,
    identityId: MAILBOX,
    leftAt: null,
    clearedAt: null,
    ...overrides,
  };
}

const seatOf = (seats: Seat[], userId: string, conversationId = THREAD) =>
  seats.find(
    (row) => row.userId === userId && row.conversationId === conversationId,
  );

describe('IdentityMailboxSyncService.resyncConversation', () => {
  it('seats a current staff member missing from this thread, from now on', async () => {
    const before = Date.now();
    const { service, seats } = makeService({
      staff: ['owner-user', 'new-colleague'],
      seats: [seat('owner-user'), seat('new-colleague', {}, 'other-thread')],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    const created = seatOf(seats, 'new-colleague');
    expect(created).toMatchObject({ identityId: MAILBOX, leftAt: null });
    expect(created?.clearedAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('reactivates a returning staff member on their own row, floored at now', async () => {
    const before = Date.now();
    const { service, seats } = makeService({
      staff: ['owner-user', 'returning-user'],
      seats: [
        seat('owner-user'),
        seat('returning-user', { leftAt: EARLIER, clearedAt: EARLIER }),
      ],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    const returning = seats.filter((row) => row.userId === 'returning-user');
    expect(returning).toHaveLength(1);
    expect(returning[0]?.leftAt).toBeNull();
    expect(returning[0]?.clearedAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('ends a departed staff member’s seat in this thread only, releases their claim here, and emits the eviction and the release', async () => {
    const { service, seats, conversationRows, eventEmitter } = makeService({
      staff: ['owner-user'],
      seats: [
        seat('owner-user'),
        seat('former-user'),
        seat('former-user', {}, 'other-thread'),
      ],
      conversations: [
        { id: THREAD, claimedByUserId: 'former-user', claimedAt: EARLIER },
        {
          id: 'other-thread',
          claimedByUserId: 'former-user',
          claimedAt: EARLIER,
        },
      ],
    });

    const changes = await service.resyncConversation(MAILBOX, THREAD);

    expect(changes.endedSeats).toEqual([
      { conversationId: THREAD, userId: 'former-user' },
    ]);
    expect(changes.staffingChanges).toEqual([]);
    expect(seatOf(seats, 'former-user')?.leftAt).toBeInstanceOf(Date);
    expect(seatOf(seats, 'former-user', 'other-thread')?.leftAt).toBeNull();
    expect(conversationRows[0]).toMatchObject({ claimedByUserId: null });
    expect(conversationRows[1]).toMatchObject({
      claimedByUserId: 'former-user',
    });
    const endedAt = seatOf(seats, 'former-user')?.leftAt;
    const releasedClaim = {
      conversationId: THREAD,
      mailboxIdentityId: MAILBOX,
      change: 'released',
      isImplicit: false,
      actorUserId: null,
      claimedByUserId: null,
      previousClaimantUserId: 'former-user',
      changedAt: endedAt,
    };
    expect(changes.releasedClaims).toEqual([releasedClaim]);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).toHaveBeenNthCalledWith(
      1,
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: THREAD, userIds: ['former-user'] },
    );
    expect(eventEmitter.emit).toHaveBeenNthCalledWith(
      2,
      CONVERSATION_CLAIM_CHANGED,
      releasedClaim,
    );
  });

  it('emits only the eviction when the departed member held no claim on this thread', async () => {
    const { service, eventEmitter } = makeService({
      staff: ['owner-user'],
      seats: [seat('owner-user'), seat('former-user')],
      conversations: [
        { id: THREAD, claimedByUserId: 'owner-user', claimedAt: EARLIER },
      ],
    });

    const changes = await service.resyncConversation(MAILBOX, THREAD);

    expect(changes.releasedClaims).toEqual([]);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: THREAD, userIds: ['former-user'] },
    );
  });

  it('defers the emission when asked, returning the ended seats and the release', async () => {
    const { service, eventEmitter } = makeService({
      staff: ['owner-user'],
      seats: [seat('owner-user'), seat('former-user')],
      conversations: [
        { id: THREAD, claimedByUserId: 'former-user', claimedAt: EARLIER },
      ],
    });

    const changes = await service.resyncConversation(
      MAILBOX,
      THREAD,
      undefined,
      { shouldDeferEmission: true },
    );

    expect(changes.endedSeats).toEqual([
      { conversationId: THREAD, userId: 'former-user' },
    ]);
    expect(changes.releasedClaims).toEqual([
      expect.objectContaining({
        conversationId: THREAD,
        change: 'released',
        previousClaimantUserId: 'former-user',
      }),
    ]);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('keeps a departed seat departed and writes nothing when the thread already agrees', async () => {
    const { service, seats, participants, eventEmitter } = makeService({
      staff: ['owner-user'],
      seats: [seat('owner-user'), seat('former-user', { leftAt: EARLIER })],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    expect(seatOf(seats, 'former-user')?.leftAt).toBe(EARLIER);
    expect(participants.update).not.toHaveBeenCalled();
    expect(participants.save).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('never reads other threads of the mailbox', async () => {
    const { service, participants } = makeService({
      staff: ['owner-user'],
      seats: [seat('owner-user')],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    // F2 (I1): the read covers every seat of THIS thread, the customer's
    // included, so a staff member who is its customer is recognised. It
    // still stays inside the one thread.
    for (const [query] of participants.find.mock.calls) {
      expect(query.where).toMatchObject({ conversationId: THREAD });
    }
  });
});

// F2 (I1): a member who wrote to the business before becoming its staff
// already sits in that thread as its customer, under their own profile
// identity. One seat per (conversation, user) means the thread keeps that
// customer seat, and the resync leaves it alone.
describe('IdentityMailboxSyncService.resyncConversation, a former customer on staff', () => {
  const CUSTOMER_IDENTITY = 'customer-profile-identity';

  it('keeps the customer seat and adds no staff seat for them in their own thread', async () => {
    const { service, seats, participants } = makeService({
      staff: ['owner-user', 'customer-user'],
      seats: [
        seat('owner-user'),
        seat('customer-user', { identityId: CUSTOMER_IDENTITY }),
      ],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    const customerSeats = seats.filter(
      (row) => row.userId === 'customer-user' && row.conversationId === THREAD,
    );
    expect(customerSeats).toHaveLength(1);
    expect(customerSeats[0]?.identityId).toBe(CUSTOMER_IDENTITY);
    expect(customerSeats[0]?.leftAt).toBeNull();
    expect(participants.save).not.toHaveBeenCalled();
    expect(participants.update).not.toHaveBeenCalled();
  });

  it('leaves a customer seat they have left as it is, with no staff reactivation', async () => {
    const { service, seats, participants } = makeService({
      staff: ['owner-user', 'customer-user'],
      seats: [
        seat('owner-user'),
        seat('customer-user', {
          identityId: CUSTOMER_IDENTITY,
          leftAt: EARLIER,
        }),
      ],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    expect(seatOf(seats, 'customer-user')).toMatchObject({
      identityId: CUSTOMER_IDENTITY,
      leftAt: EARLIER,
    });
    expect(participants.save).not.toHaveBeenCalled();
    expect(participants.update).not.toHaveBeenCalled();
  });

  it('still seats every other missing staff member in that thread', async () => {
    const { service, seats } = makeService({
      staff: ['owner-user', 'customer-user', 'new-colleague'],
      seats: [
        seat('owner-user'),
        seat('customer-user', { identityId: CUSTOMER_IDENTITY }),
      ],
    });

    await service.resyncConversation(MAILBOX, THREAD);

    expect(seatOf(seats, 'new-colleague')?.identityId).toBe(MAILBOX);
    expect(seatOf(seats, 'customer-user')?.identityId).toBe(CUSTOMER_IDENTITY);
  });
});
