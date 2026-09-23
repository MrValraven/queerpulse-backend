import { FindOperator, Repository } from 'typeorm';
import { NotificationsExportContributor } from '../account/data-export-contributors';
import { Community } from '../communities/entities/community.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MentionsInboxService } from '../mentions/mentions-inbox.service';
import type { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  describeDirectThreadSeats,
  isSeatExcludedFromMailbox,
  mailboxIdentityBlockKey,
  seatExcludedFromMailboxByStoredConversationIdPredicate,
} from '../messaging/mailbox-seats';
import { Profile } from '../users/entities/profile.entity';
import { Notification, NotificationType } from './entities/notification.entity';
import {
  MAILBOX_SEAT_READER_PARAMETER,
  visibleThroughMailboxSeatRules,
} from './notification-mailbox-block';
import { NotificationsService } from './notifications.service';

/**
 * Task 13g, audit gaps G2, G3 and G4: a mention written inside a business
 * mailbox thread before a block keeps an excerpt of that thread. Every read
 * of the member's own notification rows leaves such a row out for exactly
 * as long as the block stands.
 *
 * The rows live in a fixture, and the stand-in repository below answers
 * `find` and `count` from it. It reads the `payload` condition only when the
 * SQL that condition generates is exactly the shared predicate, and then
 * answers it through the predicate's in-memory twin
 * (`isSeatExcludedFromMailbox`), so the fixture follows the shared rule.
 * Task 14a: that rule also covers a staff member who has left the business.
 * Task 14: and both sides of a thread whose customer blocked the business.
 */

const CUSTOMER = 'customer-user';
const BLOCKED_STAFF = 'blocked-staff-user';
const COLLEAGUE = 'colleague-user';
const DEPARTED_AT = new Date('2026-09-21T10:00:00.000Z');

const CUSTOMER_IDENTITY = 'customer-identity';
const MAILBOX_IDENTITY = 'mailbox-identity';
const MAILBOX_THREAD = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

const identityKindById = new Map<string, IdentityKind>([
  [CUSTOMER_IDENTITY, IdentityKind.Profile],
  [MAILBOX_IDENTITY, IdentityKind.Listing],
]);

const threadSeats = [
  {
    conversationId: MAILBOX_THREAD,
    userId: CUSTOMER,
    identityId: CUSTOMER_IDENTITY,
  },
  {
    conversationId: MAILBOX_THREAD,
    userId: BLOCKED_STAFF,
    identityId: MAILBOX_IDENTITY,
  },
  {
    conversationId: MAILBOX_THREAD,
    userId: COLLEAGUE,
    identityId: MAILBOX_IDENTITY,
  },
] as ConversationParticipant[];

const PAYLOAD_COLUMN = 'Notification.payload';

const EXPECTED_PAYLOAD_SQL = `NOT ${seatExcludedFromMailboxByStoredConversationIdPredicate(
  `(${PAYLOAD_COLUMN} ->> 'conversationId')`,
  `:${MAILBOX_SEAT_READER_PARAMETER}`,
)}`;

/**
 * CW-20 (task-13g-review.md finding M1): `EXPECTED_PAYLOAD_SQL` above is
 * built by calling the very same production function the `payload` condition
 * calls, so a regression inside `seatExcludedFromMailboxByStoredConversationIdPredicate`
 * (or the predicates it composes in `mailbox-seats.ts`) would still make that
 * string comparison pass, since both sides recompute from the same,
 * now-wrong, source. There is no database harness in this suite to execute
 * the generated `EXISTS` subqueries and check the answer the way the
 * reviewer did by hand against a throwaway Postgres, so this list pins the
 * fragments that check by hand against `mailbox-seats.ts`, independently of
 * any call into it. Losing one of these (a swapped block direction, a
 * dropped group/official guard, a missing OR arm) changes the generated SQL
 * text and fails here even though nothing below ever runs it.
 */
const LOAD_BEARING_PAYLOAD_FRAGMENTS = [
  // blockedStaffSeatPredicate: the person block, checked in both directions,
  // and the guard that keeps the rule off group/official threads.
  '"staff_customer_block"."blocker_id" = "blocked_staff_seat"."user_id"',
  '"staff_customer_block"."blocked_id" = "blocking_customer_seat"."user_id"',
  '"staff_customer_block"."blocked_id" = "blocked_staff_seat"."user_id"',
  '"staff_customer_block"."blocker_id" = "blocking_customer_seat"."user_id"',
  `"blocked_staff_identity"."kind" <> 'profile'`,
  `"blocked_staff_conversation"."kind" <> 'group'`,
  '"blocked_staff_conversation"."is_official" = false',
  '"staff_business_identity_block"."blocker_user_id" = "blocking_customer_seat"."user_id"',
  '"staff_business_identity_block"."identity_id" = "blocked_staff_seat"."identity_id"',
  // departedStaffSeatPredicate: the departure itself.
  '"departed_staff_seat"."left_at" IS NOT NULL',
  // identityBlockedCustomerSeatPredicate: the customer's own block of the
  // business, keyed off the customer as the blocker.
  `"identity_blocking_customer_identity"."kind" = 'profile'`,
  `"identity_blocked_business_identity"."kind" <> 'profile'`,
  '"customer_business_identity_block"."blocker_user_id" = "identity_blocking_customer_seat"."user_id"',
  '"customer_business_identity_block"."identity_id" = "identity_blocked_business_seat"."identity_id"',
  // The stored-conversation-id cast this predicate adds on top of the shared
  // one: it stays inside a CASE, so a malformed value simply reads as "no
  // thread".
  `~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
] as const;

function mentionInThread(id: string, userId: string): Notification {
  return {
    id,
    userId,
    type: NotificationType.Mention,
    payload: {
      source: 'message',
      conversationId: MAILBOX_THREAD,
      messageId: 'message-1',
      actorId: CUSTOMER,
      excerpt: 'can you check my booking for the 14th',
    },
    read: false,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
  } as unknown as Notification;
}

function unrelatedMention(id: string, userId: string): Notification {
  return {
    id,
    userId,
    type: NotificationType.Mention,
    payload: { source: 'forum', threadSlug: 'welcome', actorId: COLLEAGUE },
    read: false,
    createdAt: new Date('2026-09-20T09:00:00.000Z'),
  } as unknown as Notification;
}

/**
 * The stand-in repository. `blockPairs`, `identityBlockPairs` and
 * `departedUserIds` are read at query time, so a test can place a block and
 * lift it, or unseat a staff member and seat them again, between two reads
 * of the same rows. An identity block pair is `[blockerUserId, identityId]`.
 */
function buildNotificationFixture(rows: Notification[]) {
  const state = {
    blockPairs: [] as Array<[string, string]>,
    identityBlockPairs: [] as Array<[string, string]>,
    departedUserIds: new Set<string>(),
  };

  function isRowVisible(
    row: Notification,
    payloadCondition: FindOperator<unknown>,
  ): boolean {
    const generatedSql = payloadCondition.getSql?.(PAYLOAD_COLUMN);
    if (generatedSql !== EXPECTED_PAYLOAD_SQL) {
      throw new Error(`Unrecognised payload condition: ${generatedSql}`);
    }
    const readerUserId = payloadCondition.objectLiteralParameters?.[
      MAILBOX_SEAT_READER_PARAMETER
    ] as string;
    const conversationId = row.payload?.conversationId;
    const currentSeats = threadSeats.map((seat) => ({
      ...seat,
      leftAt: state.departedUserIds.has(seat.userId) ? DEPARTED_AT : null,
    }));
    const readerSeat = currentSeats.find(
      (seat) =>
        seat.conversationId === conversationId && seat.userId === readerUserId,
    );
    if (!readerSeat) {
      return true;
    }
    const blockedUserIds = new Set<string>();
    for (const [blockerId, blockedId] of state.blockPairs) {
      if (blockerId === readerUserId) blockedUserIds.add(blockedId);
      if (blockedId === readerUserId) blockedUserIds.add(blockerId);
    }
    return !isSeatExcludedFromMailbox(
      readerSeat,
      describeDirectThreadSeats(
        readerSeat.identityId,
        currentSeats.filter(
          (seat) =>
            seat.conversationId === conversationId && seat !== readerSeat,
        ),
        identityKindById,
      ),
      blockedUserIds,
      new Set(
        state.identityBlockPairs.map(([blockerUserId, identityId]) =>
          mailboxIdentityBlockKey(blockerUserId, identityId),
        ),
      ),
    );
  }

  function matching(where: Record<string, unknown>): Notification[] {
    return rows.filter((row) =>
      Object.entries(where).every(([key, expected]) => {
        if (key === 'payload') {
          return isRowVisible(row, expected as FindOperator<unknown>);
        }
        return (row as unknown as Record<string, unknown>)[key] === expected;
      }),
    );
  }

  const repository = {
    find: jest.fn((options: { where: Record<string, unknown> }) =>
      Promise.resolve(matching(options.where)),
    ),
    count: jest.fn((options: { where: Record<string, unknown> }) =>
      Promise.resolve(matching(options.where).length),
    ),
  };
  return { repository, state };
}

const emptyFind = { find: jest.fn().mockResolvedValue([]) };

function buildNotificationsService(repository: unknown): NotificationsService {
  return Object.assign(Object.create(NotificationsService.prototype), {
    notifications: repository,
    profiles: emptyFind,
  }) as NotificationsService;
}

function buildMentionsInbox(repository: unknown): MentionsInboxService {
  return new MentionsInboxService(
    repository as Repository<Notification>,
    emptyFind as unknown as Repository<Profile>,
    emptyFind as unknown as Repository<ForumThread>,
    emptyFind as unknown as Repository<Community>,
  );
}

describe('visibleThroughMailboxSeatRules', () => {
  it('composes the shared predicate on the payload conversation id, bound to the reader', () => {
    const condition = visibleThroughMailboxSeatRules(BLOCKED_STAFF);

    expect(condition.getSql?.(PAYLOAD_COLUMN)).toBe(EXPECTED_PAYLOAD_SQL);
    expect(condition.objectLiteralParameters).toEqual({
      [MAILBOX_SEAT_READER_PARAMETER]: BLOCKED_STAFF,
    });
  });

  it('guards the text-to-uuid cast, so a malformed stored id cannot fail the query', () => {
    const generatedSql =
      visibleThroughMailboxSeatRules(BLOCKED_STAFF).getSql?.(PAYLOAD_COLUMN);

    expect(generatedSql).toContain(
      `CASE WHEN (${PAYLOAD_COLUMN} ->> 'conversationId') ~* '`,
    );
    expect(generatedSql).toContain(
      `THEN CAST((${PAYLOAD_COLUMN} ->> 'conversationId') AS uuid) END`,
    );
  });

  // CW-20 (M1): see LOAD_BEARING_PAYLOAD_FRAGMENTS's own comment. This is the
  // closest this suite gets, with no database to run the SQL against, to a
  // check that fails on a semantically wrong clause rather than one that only
  // compares a computed string to itself.
  it('carries every load-bearing block-direction and identity-kind guard the SQL depends on', () => {
    for (const fragment of LOAD_BEARING_PAYLOAD_FRAGMENTS) {
      expect(EXPECTED_PAYLOAD_SQL).toContain(fragment);
    }
  });
});

describe('G2: the mentions inbox', () => {
  it('drops a pre-block mention for the blocked staff member, and shows it again once the block is lifted', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('mention-in-thread', BLOCKED_STAFF),
      unrelatedMention('mention-elsewhere', BLOCKED_STAFF),
    ]);
    const inbox = buildMentionsInbox(repository);

    const beforeBlock = await inbox.list(BLOCKED_STAFF, {});
    state.blockPairs = [[CUSTOMER, BLOCKED_STAFF]];
    const duringBlock = await inbox.list(BLOCKED_STAFF, {});
    state.blockPairs = [];
    const afterLift = await inbox.list(BLOCKED_STAFF, {});

    expect(beforeBlock.items.map((item) => item.id)).toEqual([
      'mention-in-thread',
      'mention-elsewhere',
    ]);
    expect(duringBlock.items.map((item) => item.id)).toEqual([
      'mention-elsewhere',
    ]);
    expect(duringBlock.total).toBe(1);
    expect(JSON.stringify(duringBlock)).not.toContain('booking for the 14th');
    expect(afterLift.items.map((item) => item.id)).toEqual([
      'mention-in-thread',
      'mention-elsewhere',
    ]);
  });

  it('applies when the staff member placed the block, the other direction of the same rule', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('mention-in-thread', BLOCKED_STAFF),
    ]);
    state.blockPairs = [[BLOCKED_STAFF, CUSTOMER]];

    const result = await buildMentionsInbox(repository).list(BLOCKED_STAFF, {});

    expect(result.items).toEqual([]);
  });

  it("keeps a colleague's mention from the same thread", async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('colleague-mention', COLLEAGUE),
    ]);
    state.blockPairs = [[CUSTOMER, BLOCKED_STAFF]];

    const result = await buildMentionsInbox(repository).list(COLLEAGUE, {});

    expect(result.items.map((item) => item.id)).toEqual(['colleague-mention']);
  });
});

describe('G3: the notification bell and its unread badge', () => {
  it('drops a pre-block mention from the list and the badge while the block stands, and restores both when it is lifted', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('mention-in-thread', BLOCKED_STAFF),
      unrelatedMention('mention-elsewhere', BLOCKED_STAFF),
    ]);
    const service = buildNotificationsService(repository);

    state.blockPairs = [[CUSTOMER, BLOCKED_STAFF]];
    const listDuringBlock = await service.list(BLOCKED_STAFF);
    const badgeDuringBlock = await service.unreadCount(BLOCKED_STAFF);
    state.blockPairs = [];
    const listAfterLift = await service.list(BLOCKED_STAFF);
    const badgeAfterLift = await service.unreadCount(BLOCKED_STAFF);

    expect(listDuringBlock.items.map((item) => item.id)).toEqual([
      'mention-elsewhere',
    ]);
    expect(listDuringBlock.total).toBe(1);
    expect(badgeDuringBlock).toBe(1);
    expect(listAfterLift.items.map((item) => item.id)).toEqual([
      'mention-in-thread',
      'mention-elsewhere',
    ]);
    expect(badgeAfterLift).toBe(2);
  });

  it("leaves the customer's own bell unchanged by their block", async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('customer-row', CUSTOMER),
    ]);
    state.blockPairs = [[CUSTOMER, BLOCKED_STAFF]];
    const service = buildNotificationsService(repository);

    await expect(service.unreadCount(CUSTOMER)).resolves.toBe(1);
  });
});

describe('G4: the notifications section of the data export', () => {
  it('leaves a pre-block mention, excerpt and all, out of the export while the block stands, and puts it back once lifted', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('mention-in-thread', BLOCKED_STAFF),
      unrelatedMention('mention-elsewhere', BLOCKED_STAFF),
    ]);
    const contributor = new NotificationsExportContributor(
      repository as unknown as Repository<Notification>,
    );

    state.blockPairs = [[CUSTOMER, BLOCKED_STAFF]];
    const duringBlock = await contributor.buildContribution(BLOCKED_STAFF);
    state.blockPairs = [];
    const afterLift = await contributor.buildContribution(BLOCKED_STAFF);

    expect(JSON.stringify(duringBlock)).not.toContain('booking for the 14th');
    expect((duringBlock as Array<{ id: string }>).map((row) => row.id)).toEqual(
      ['mention-elsewhere'],
    );
    expect(JSON.stringify(afterLift)).toContain('booking for the 14th');
  });
});

describe('Task 14a: a staff member who left the business', () => {
  // BLOCKED_STAFF plays the departing staff member here, with no block
  // placed: the departure alone is what hides the row.
  const DEPARTING_STAFF = BLOCKED_STAFF;

  it('drops a mention written before they left from the mentions inbox, and shows it again once they are seated again', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('mention-in-thread', DEPARTING_STAFF),
      unrelatedMention('mention-elsewhere', DEPARTING_STAFF),
    ]);
    const inbox = buildMentionsInbox(repository);

    state.departedUserIds = new Set([DEPARTING_STAFF]);
    const afterLeaving = await inbox.list(DEPARTING_STAFF, {});
    state.departedUserIds = new Set();
    const afterReseating = await inbox.list(DEPARTING_STAFF, {});

    expect(afterLeaving.items.map((item) => item.id)).toEqual([
      'mention-elsewhere',
    ]);
    expect(afterLeaving.total).toBe(1);
    expect(JSON.stringify(afterLeaving)).not.toContain('booking for the 14th');
    expect(afterReseating.items.map((item) => item.id)).toEqual([
      'mention-in-thread',
      'mention-elsewhere',
    ]);
  });

  it('drops the row from the bell and its badge, and leaves the live colleague and the customer theirs', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('departed-row', DEPARTING_STAFF),
      mentionInThread('colleague-row', COLLEAGUE),
      mentionInThread('customer-row', CUSTOMER),
    ]);
    const service = buildNotificationsService(repository);
    state.departedUserIds = new Set([DEPARTING_STAFF]);

    const departedList = await service.list(DEPARTING_STAFF);

    expect(departedList.items).toEqual([]);
    await expect(service.unreadCount(DEPARTING_STAFF)).resolves.toBe(0);
    await expect(service.unreadCount(COLLEAGUE)).resolves.toBe(1);
    await expect(service.unreadCount(CUSTOMER)).resolves.toBe(1);
  });

  it('leaves the row, excerpt and all, out of the data export', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('mention-in-thread', DEPARTING_STAFF),
    ]);
    const contributor = new NotificationsExportContributor(
      repository as unknown as Repository<Notification>,
    );
    state.departedUserIds = new Set([DEPARTING_STAFF]);

    const exported = await contributor.buildContribution(DEPARTING_STAFF);

    expect(exported).toEqual([]);
  });
});

describe('Task 14: a customer who blocked the business', () => {
  const STAFF = BLOCKED_STAFF;

  it('drops the mention for the customer and for every staff member from the mentions inbox, and shows it again after the unblock', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('customer-row', CUSTOMER),
      mentionInThread('staff-row', STAFF),
      mentionInThread('colleague-row', COLLEAGUE),
      unrelatedMention('customer-elsewhere', CUSTOMER),
    ]);
    const inbox = buildMentionsInbox(repository);

    state.identityBlockPairs = [[CUSTOMER, MAILBOX_IDENTITY]];
    const customerDuringBlock = await inbox.list(CUSTOMER, {});
    const staffDuringBlock = await inbox.list(STAFF, {});
    const colleagueDuringBlock = await inbox.list(COLLEAGUE, {});
    state.identityBlockPairs = [];
    const customerAfterUnblock = await inbox.list(CUSTOMER, {});
    const staffAfterUnblock = await inbox.list(STAFF, {});

    expect(customerDuringBlock.items.map((item) => item.id)).toEqual([
      'customer-elsewhere',
    ]);
    expect(staffDuringBlock.items).toEqual([]);
    expect(colleagueDuringBlock.items).toEqual([]);
    expect(JSON.stringify(staffDuringBlock)).not.toContain(
      'booking for the 14th',
    );
    expect(customerAfterUnblock.items.map((item) => item.id)).toEqual([
      'customer-row',
      'customer-elsewhere',
    ]);
    expect(staffAfterUnblock.items.map((item) => item.id)).toEqual([
      'staff-row',
    ]);
  });

  it('drops the row from both sides of the bell and its badge, and restores both after the unblock', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('customer-row', CUSTOMER),
      mentionInThread('staff-row', STAFF),
    ]);
    const service = buildNotificationsService(repository);

    state.identityBlockPairs = [[CUSTOMER, MAILBOX_IDENTITY]];
    const customerListDuringBlock = await service.list(CUSTOMER);
    const customerBadgeDuringBlock = await service.unreadCount(CUSTOMER);
    const staffBadgeDuringBlock = await service.unreadCount(STAFF);
    state.identityBlockPairs = [];

    expect(customerListDuringBlock.items).toEqual([]);
    expect(customerBadgeDuringBlock).toBe(0);
    expect(staffBadgeDuringBlock).toBe(0);
    await expect(service.unreadCount(CUSTOMER)).resolves.toBe(1);
    await expect(service.unreadCount(STAFF)).resolves.toBe(1);
  });

  it('leaves every row of this thread alone when the customer blocked a different business', async () => {
    const { repository, state } = buildNotificationFixture([
      mentionInThread('customer-row', CUSTOMER),
      mentionInThread('colleague-row', COLLEAGUE),
    ]);
    const service = buildNotificationsService(repository);
    state.identityBlockPairs = [[CUSTOMER, 'another-business-identity']];

    await expect(service.unreadCount(CUSTOMER)).resolves.toBe(1);
    await expect(service.unreadCount(COLLEAGUE)).resolves.toBe(1);
  });
});
