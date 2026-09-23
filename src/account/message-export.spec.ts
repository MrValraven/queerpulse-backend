import type { EntityManager } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import type { IdentityDescription } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message, MessageKind } from '../messaging/entities/message.entity';
import { seatExcludedFromMailboxPredicate } from '../messaging/mailbox-seats';
import {
  FORMER_IDENTITY_DISPLAY_NAME,
  FORMER_MEMBER_DISPLAY_NAME,
} from '../messaging/message-response';
import { Profile } from '../users/entities/profile.entity';
import {
  buildOwnMessagesExport,
  buildReportedConversationsExport,
  ExportIdentities,
  resolveDirectConversationTitleForExport,
} from './message-export';

/**
 * Task 13f: a business mailbox thread must export to the CUSTOMER'S OWN
 * archive with the business alone naming its side of the conversation.
 * These tests assert on what the exported document actually contains,
 * mirroring the brief's own instruction to serialize the export and search
 * it for any staff name, handle, avatar or user id.
 */

const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';

const identityKindById = new Map([
  [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
  [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
]);

const BUSINESS_DESCRIPTION: IdentityDescription = {
  displayName: 'Acme Cafe',
  handle: 'acme-cafe',
  avatarUrl: 'https://cdn.example/acme.png',
};

function seat(
  userId: string,
  identityId: string,
  conversationId = 'conversation-1',
): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId,
    userId,
    identityId,
    leftAt: null,
  } as unknown as ConversationParticipant;
}

function profile(overrides: Partial<Profile>): Profile {
  return {
    userId: 'user-x',
    firstName: 'First',
    lastName: 'Last',
    slug: 'first-last',
    pronouns: null,
    avatarUrl: null,
    photoVisible: true,
    ...overrides,
  } as Profile;
}

describe('resolveDirectConversationTitleForExport (Task 13f)', () => {
  it('names the counterpart by their own profile for an ordinary DM', () => {
    const ownSeat = seat('customer-1', CUSTOMER_IDENTITY_ID);
    const otherSeat = seat('member-2', 'identity-member-2');
    const kinds = new Map([
      [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
      ['identity-member-2', IdentityKind.Profile],
    ]);
    const profileByUser = new Map([
      ['member-2', profile({ userId: 'member-2', firstName: 'Robin' })],
    ]);

    const title = resolveDirectConversationTitleForExport(
      ownSeat,
      [otherSeat],
      kinds,
      new Map(),
      profileByUser,
    );

    expect(title).toBe('Robin Last');
  });

  it('names a mailbox thread by the business alone, for a customer exporting their own archive', () => {
    const ownSeat = seat('customer-1', CUSTOMER_IDENTITY_ID);
    const staffOne = seat('staff-1', MAILBOX_IDENTITY_ID);
    const staffTwo = seat('staff-2', MAILBOX_IDENTITY_ID);
    const identityDescriptionById = new Map([
      [MAILBOX_IDENTITY_ID, BUSINESS_DESCRIPTION],
    ]);
    // A customer's own export resolves only their own profile; the fixture
    // matches what `loadConversationContexts` would actually fetch, with the
    // profile map carrying their own row alone.
    const profileByUser = new Map<string, Profile>();

    const title = resolveDirectConversationTitleForExport(
      ownSeat,
      [staffOne, staffTwo],
      identityKindById,
      identityDescriptionById,
      profileByUser,
    );

    expect(title).toBe('Acme Cafe');
    expect(title).not.toMatch(/staff/i);
  });

  it('names a mailbox thread by the customer, for a staff member exporting their own archive', () => {
    const ownSeat = seat('staff-1', MAILBOX_IDENTITY_ID);
    const customerSeat = seat('customer-1', CUSTOMER_IDENTITY_ID);
    const profileByUser = new Map([
      [
        'customer-1',
        profile({
          userId: 'customer-1',
          firstName: 'Jamie',
          lastName: 'Customer',
        }),
      ],
    ]);

    const title = resolveDirectConversationTitleForExport(
      ownSeat,
      [customerSeat],
      identityKindById,
      new Map(),
      profileByUser,
    );

    expect(title).toBe('Jamie Customer');
  });

  it('falls back to the "former member" placeholder when the own seat cannot be found', () => {
    const title = resolveDirectConversationTitleForExport(
      undefined,
      [],
      identityKindById,
      new Map(),
      new Map(),
    );

    expect(title).toBe(FORMER_MEMBER_DISPLAY_NAME);
  });

  it('fix round 1: names an ORDINARY DM whose counterpart erased their account with the "Former member" placeholder', () => {
    const ownSeat = seat('customer-1', CUSTOMER_IDENTITY_ID);
    // `conversation_participants.user_id` cascades on delete, so a DM
    // counterpart who erased their account leaves no seat row at all: the
    // empty array here stands for that genuinely gone seat.
    const title = resolveDirectConversationTitleForExport(
      ownSeat,
      [],
      identityKindById,
      new Map(),
      new Map(),
    );

    expect(title).toBe(FORMER_MEMBER_DISPLAY_NAME);
    expect(title).not.toBe(FORMER_IDENTITY_DISPLAY_NAME);
  });

  it('falls back to the placeholder for a staff caller whose customer seat is ambiguous, without guessing', () => {
    const ownSeat = seat('staff-1', MAILBOX_IDENTITY_ID);
    // Two seats resolving to a non-mailbox identity: the data-integrity
    // anomaly `renderDirectCounterpart` refuses to guess between.
    const anomalySeats = [
      seat('user-a', 'identity-a'),
      seat('user-b', 'identity-b'),
    ];
    const kinds = new Map([
      [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
      ['identity-a', IdentityKind.Profile],
      ['identity-b', IdentityKind.Profile],
    ]);

    const title = resolveDirectConversationTitleForExport(
      ownSeat,
      anomalySeats,
      kinds,
      new Map(),
      new Map(),
    );

    expect(title).toBe(FORMER_MEMBER_DISPLAY_NAME);
  });
});

// ---------------------------------------------------------------------------
// Round-trip tests through the exported builders, with a hand-mocked
// EntityManager dispatching by entity class: one fake repo per entity, the
// shape this file's own queries need, with no ORM actually running.
// ---------------------------------------------------------------------------

interface MessageQueryBuilderStub {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getRawMany: jest.Mock;
}

function makeMessagesRepo(rowBatchQueue: unknown[][]) {
  const queue = [...rowBatchQueue];
  const createQueryBuilder = jest.fn((): MessageQueryBuilderStub => {
    const builder = {} as MessageQueryBuilderStub;
    const self = () => builder;
    builder.select = jest.fn(self);
    builder.addSelect = jest.fn(self);
    builder.where = jest.fn(self);
    builder.andWhere = jest.fn(self);
    builder.setParameter = jest.fn(self);
    builder.orderBy = jest.fn(self);
    builder.addOrderBy = jest.fn(self);
    builder.limit = jest.fn(self);
    builder.getRawMany = jest.fn(() => Promise.resolve(queue.shift() ?? []));
    return builder;
  });
  return { createQueryBuilder };
}

interface FakeManagerOptions {
  reportedConversationIdRows?: { conversationId: string }[];
  conversations?: Partial<Conversation>[];
  /** Every direct thread's full seat list, across every conversation in the
   *  fixture, the way `loadConversationContexts` reads them all in one query. */
  seats?: ConversationParticipant[];
  ownParticipants?: Partial<ConversationParticipant>[];
  profiles?: Partial<Profile>[];
  messageRowBatches?: unknown[][];
}

function buildFakeManager(options: FakeManagerOptions) {
  const conversationsRepo = {
    find: jest.fn().mockResolvedValue(options.conversations ?? []),
  };
  const participantsRepo = {
    find: jest.fn((args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      // The reported-conversations own-participant lookup queries a bare
      // `userId` (an exact string); the seats lookup this file's own Task
      // 13f code added never does. That is the one shape difference between
      // the two `ConversationParticipant.find` calls this module makes.
      if (typeof where.userId === 'string') {
        return Promise.resolve(options.ownParticipants ?? []);
      }
      return Promise.resolve(options.seats ?? []);
    }),
  };
  const profilesRepo = {
    find: jest.fn().mockResolvedValue(options.profiles ?? []),
  };
  const messagesRepo = makeMessagesRepo(options.messageRowBatches ?? []);
  const query = jest
    .fn()
    .mockResolvedValue(options.reportedConversationIdRows ?? []);
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === Conversation) return conversationsRepo;
    if (entity === ConversationParticipant) return participantsRepo;
    if (entity === Profile) return profilesRepo;
    if (entity === Message) return messagesRepo;
    throw new Error('buildFakeManager: unexpected repository requested');
  });
  return { getRepository, query } as unknown as EntityManager;
}

function buildFakeIdentities(
  identityRows: { id: string; kind: IdentityKind }[],
  descriptionById: Map<string, IdentityDescription>,
): ExportIdentities {
  return {
    getByIds: jest.fn().mockResolvedValue(identityRows),
    describeIdentities: jest.fn().mockResolvedValue(descriptionById),
  };
}

/** Every string a leaked staff identity could surface as, none of which may
 *  appear anywhere in a customer's own serialized export. */
const STAFF_LEAK_NEEDLES = [
  'staff-1',
  'staff-2',
  'Staff One',
  'Staff Two',
  'staff-one-slug',
  'https://cdn.example/staff-one.png',
];

describe('buildOwnMessagesExport (Task 13f)', () => {
  it("names a mailbox thread's conversationTitle after the business, for the customer's own export, with no staff identity anywhere in the serialized result", async () => {
    const manager = buildFakeManager({
      conversations: [
        {
          id: 'conversation-1',
          isOfficial: false,
          kind: 'direct' as never,
          title: null,
        },
      ],
      seats: [
        seat('customer-1', CUSTOMER_IDENTITY_ID),
        seat('staff-1', MAILBOX_IDENTITY_ID),
        seat('staff-2', MAILBOX_IDENTITY_ID),
      ],
      messageRowBatches: [
        [
          {
            id: 'message-1',
            conversationId: 'conversation-1',
            senderId: 'customer-1',
            senderIdentityId: null,
            body: 'hello, what are your hours?',
            kind: MessageKind.User,
            attachment: null,
            replyToId: null,
            forwarded: false,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            editedAt: null,
            exactCreatedAt: '2026-01-01T00:00:00.000000Z',
          },
        ],
      ],
    });
    const identities = buildFakeIdentities(
      [
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
      ],
      new Map([[MAILBOX_IDENTITY_ID, BUSINESS_DESCRIPTION]]),
    );

    const exported = await buildOwnMessagesExport(
      manager,
      'customer-1',
      identities,
    );

    expect(exported).toHaveLength(1);
    expect(exported[0]!.conversationTitle).toBe('Acme Cafe');

    const serialized = JSON.stringify(exported);
    for (const needle of STAFF_LEAK_NEEDLES) {
      expect(serialized).not.toContain(needle);
    }
  });
});

describe('buildReportedConversationsExport (Task 13f, fix round 1)', () => {
  /** The three arms of `REPORTED_CONVERSATION_IDS_SQL`, split on the literal
   *  `UNION` between them, in source order. A helper so every test below
   *  reads its own arm and nothing but its own arm. */
  async function reportedConversationIdsSqlArms(): Promise<
    [string, string, string]
  > {
    const manager = buildFakeManager({ reportedConversationIdRows: [] });
    const identities = buildFakeIdentities([], new Map());

    await buildReportedConversationsExport(manager, 'customer-1', identities);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- a plain jest.fn(), read for its own captured calls only
    const query = manager.query as jest.Mock;
    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0] as [string];
    const arms = sql.split(/\n\s*UNION\s*\n/);
    expect(arms).toHaveLength(3);
    return arms as [string, string, string];
  }

  it("carries the asymmetric block rule on the exporting member's own seat, in every one of the three arms", async () => {
    const [messageArm, memberArm, erasedArm] =
      await reportedConversationIdsSqlArms();

    for (const arm of [messageArm, memberArm, erasedArm]) {
      expect(arm).toContain('blocked_staff_seat');
      expect(arm).toContain(
        `AND NOT ${seatExcludedFromMailboxPredicate('"own"."conversation_id"', '$1')}`,
      );
    }
  });

  it("arm 2 (member report): a staff member reporting a customer from inside the mailbox thread keeps that thread, since the matched counterpart is the customer's own profile seat", async () => {
    const [, memberArm] = await reportedConversationIdsSqlArms();

    // The join key alone (`counterpart.user_id = reported_profile.user_id`)
    // matches this case fine; what this test exists to confirm is the added
    // kind='profile' condition ADMITTING it, where the old blanket mailbox
    // exclusion used to drop the whole thread regardless of who reported
    // whom.
    expect(memberArm).toMatch(
      /JOIN "identities" "counterpart_identity"\s*\n\s*ON "counterpart_identity"."id" = "counterpart"."identity_id"\s*\n\s*AND "counterpart_identity"."kind" = 'profile'/,
    );
    expect(memberArm).not.toContain('mailbox_seat');
    expect(memberArm).not.toContain('mailbox_identity');
  });

  it("arm 2 (member report): a customer's report that matches a staff member's seat by user id excludes that business thread, since a staff seat's own identity always names the mailbox", async () => {
    const [, memberArm] = await reportedConversationIdsSqlArms();

    // A plain INNER join: when `counterpart_identity.kind` names the
    // mailbox (a staff seat, whose `identity_id` speaks for the business),
    // the join produces no row for that candidate at all, dropping the
    // whole thread from the result set on its own, with no later WHERE
    // clause needed to remember to check it.
    expect(memberArm).toContain('JOIN "identities" "counterpart_identity"');
    expect(memberArm).not.toContain(
      'LEFT JOIN "identities" "counterpart_identity"',
    );
  });

  it('excludes a held message sent as a non-profile identity from arm 3 (erased sender), so a business thread never surfaces next to a report about a since-erased PERSONAL profile', async () => {
    const [, , erasedArm] = await reportedConversationIdsSqlArms();

    expect(erasedArm).toMatch(
      /AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM "identities" "held_identity"\s*\n\s*WHERE "held_identity"."id" = "held"."sender_identity_id"\s*\n\s*AND "held_identity"."kind" <> 'profile'\s*\n\s*\)/,
    );
  });

  it('names a mailbox reply after the business in the reported-conversations export, with no staff identity anywhere in the serialized result', async () => {
    const manager = buildFakeManager({
      reportedConversationIdRows: [{ conversationId: 'conversation-1' }],
      conversations: [
        {
          id: 'conversation-1',
          isOfficial: false,
          kind: 'direct' as never,
          title: null,
        },
      ],
      seats: [
        seat('customer-1', CUSTOMER_IDENTITY_ID),
        seat('staff-1', MAILBOX_IDENTITY_ID),
      ],
      ownParticipants: [
        {
          id: 'own-participant',
          conversationId: 'conversation-1',
          clearedAt: null,
          leftAt: null,
        },
      ],
      profiles: [profile({ userId: 'customer-1', firstName: 'Jamie' })],
      // `readNewestMessages` reads pages as a real DESC query would (newest
      // first) and reverses them into oldest-first before returning, so this
      // fixture batch is deliberately supplied NEWEST first: message-2, then
      // message-1. After the reverse, `conversation.rows` is
      // [message-1 (staff), message-2 (customer)], matching the destructure
      // below.
      messageRowBatches: [
        [
          {
            id: 'message-2',
            conversationId: 'conversation-1',
            senderId: 'customer-1',
            senderIdentityId: null,
            body: 'thank you!',
            kind: MessageKind.User,
            attachment: null,
            replyToId: null,
            forwarded: false,
            createdAt: new Date('2026-01-01T00:01:00.000Z'),
            editedAt: null,
            exactCreatedAt: '2026-01-01T00:01:00.000000Z',
          },
          {
            id: 'message-1',
            conversationId: 'conversation-1',
            senderId: 'staff-1',
            senderIdentityId: MAILBOX_IDENTITY_ID,
            body: "we're open till 6pm",
            kind: MessageKind.User,
            attachment: null,
            replyToId: null,
            forwarded: false,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            editedAt: null,
            exactCreatedAt: '2026-01-01T00:00:00.000000Z',
          },
        ],
      ],
    });
    const identities = buildFakeIdentities(
      [
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
      ],
      new Map([[MAILBOX_IDENTITY_ID, BUSINESS_DESCRIPTION]]),
    );

    const exported = await buildReportedConversationsExport(
      manager,
      'customer-1',
      identities,
    );

    expect(exported).toHaveLength(1);
    expect(exported[0]!.conversationTitle).toBe('Acme Cafe');
    const [staffMessage, ownMessage] = exported[0]!.messages;
    expect(staffMessage!.senderDisplayName).toBe('Acme Cafe');
    expect(staffMessage!.isOwnMessage).toBe(false);
    // The customer's OWN message stays attributed to the customer alone.
    expect(ownMessage!.senderDisplayName).toBe('Jamie Last');
    expect(ownMessage!.isOwnMessage).toBe(true);

    const serialized = JSON.stringify(exported);
    for (const needle of STAFF_LEAK_NEEDLES) {
      expect(serialized).not.toContain(needle);
    }
  });
});
