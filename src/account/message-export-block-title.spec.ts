import type { EntityManager } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import type { IdentityDescription } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message, MessageKind } from '../messaging/entities/message.entity';
import { staffSeatExcludedFromMailboxPredicate } from '../messaging/mailbox-seats';
import { Profile } from '../users/entities/profile.entity';
import {
  buildOwnMessagesExport,
  ExportIdentities,
  resolveDirectConversationTitleForExport,
} from './message-export';

/**
 * Task 13g, audit gap G5: a staff member's own-messages export titled the
 * customer's thread with the customer's CURRENT display name, after the
 * customer had blocked them. The staff member's own messages stay, and the
 * thread is titled with the business's own name while the block stands.
 */

const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const CONVERSATION_ID = 'conversation-1';

const identityKindById = new Map([
  [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
  [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
]);

const BUSINESS_DESCRIPTION: IdentityDescription = {
  displayName: 'Acme Cafe',
  handle: 'acme-cafe',
  avatarUrl: null,
};

const CUSTOMER_PROFILE = {
  userId: 'customer-1',
  firstName: 'Jamie',
  lastName: 'Renamed',
  slug: 'jamie-renamed',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
} as unknown as Profile;

function seat(userId: string, identityId: string): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId,
    leftAt: null,
  } as unknown as ConversationParticipant;
}

const staffSeat = seat('staff-1', MAILBOX_IDENTITY_ID);
const customerSeat = seat('customer-1', CUSTOMER_IDENTITY_ID);

describe('resolveDirectConversationTitleForExport, Task 13g', () => {
  it('titles the thread with the business when the staff exporter is excluded by a block', () => {
    const title = resolveDirectConversationTitleForExport(
      staffSeat,
      [customerSeat],
      identityKindById,
      new Map([[MAILBOX_IDENTITY_ID, BUSINESS_DESCRIPTION]]),
      new Map([['customer-1', CUSTOMER_PROFILE]]),
      true,
    );

    expect(title).toBe('Acme Cafe');
  });

  it("keeps the customer's name for a staff exporter no block excludes", () => {
    const title = resolveDirectConversationTitleForExport(
      staffSeat,
      [customerSeat],
      identityKindById,
      new Map([[MAILBOX_IDENTITY_ID, BUSINESS_DESCRIPTION]]),
      new Map([['customer-1', CUSTOMER_PROFILE]]),
      false,
    );

    expect(title).toBe('Jamie Renamed');
  });
});

/** Answers the exclusion query from `excludedConversationIds`, and records
 *  the clauses it was given. */
function buildFakeManager(excludedConversationIds: string[]) {
  const exclusionClauses: string[] = [];
  const exclusionBuilder: Record<string, jest.Mock> = {};
  const returnBuilder = () => exclusionBuilder;
  exclusionBuilder.select = jest.fn(returnBuilder);
  exclusionBuilder.where = jest.fn(returnBuilder);
  exclusionBuilder.andWhere = jest.fn((clause: string) => {
    exclusionClauses.push(clause);
    return exclusionBuilder;
  });
  exclusionBuilder.getRawMany = jest.fn(() =>
    Promise.resolve(
      excludedConversationIds.map((conversationId) => ({ conversationId })),
    ),
  );
  const participantsRepo = {
    find: jest.fn().mockResolvedValue([staffSeat, customerSeat]),
    createQueryBuilder: jest.fn(() => exclusionBuilder),
  };
  const conversationsRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: CONVERSATION_ID,
        isOfficial: false,
        kind: 'direct',
        title: null,
      },
    ]),
  };
  const profilesRepo = {
    find: jest.fn().mockResolvedValue([CUSTOMER_PROFILE]),
  };
  const messageRows = [
    {
      id: 'message-1',
      conversationId: CONVERSATION_ID,
      senderId: 'staff-1',
      senderIdentityId: MAILBOX_IDENTITY_ID,
      body: 'your table is booked',
      kind: MessageKind.User,
      attachment: null,
      replyToId: null,
      forwarded: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      editedAt: null,
      exactCreatedAt: '2026-01-01T00:00:00.000000Z',
    },
  ];
  const rowBatches: unknown[][] = [messageRows];
  const messagesRepo = {
    createQueryBuilder: jest.fn(() => {
      const builder: Record<string, jest.Mock> = {};
      const self = () => builder;
      for (const method of [
        'select',
        'addSelect',
        'where',
        'andWhere',
        'setParameter',
        'orderBy',
        'addOrderBy',
        'limit',
      ]) {
        builder[method] = jest.fn(self);
      }
      builder.getRawMany = jest.fn(() =>
        Promise.resolve(rowBatches.shift() ?? []),
      );
      return builder;
    }),
  };
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === Conversation) return conversationsRepo;
    if (entity === ConversationParticipant) return participantsRepo;
    if (entity === Profile) return profilesRepo;
    if (entity === Message) return messagesRepo;
    throw new Error('unexpected repository requested');
  });
  const manager = {
    getRepository,
    query: jest.fn(),
  } as unknown as EntityManager;
  return { manager, exclusionClauses };
}

const identities: ExportIdentities = {
  getByIds: jest.fn().mockResolvedValue([
    { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
    { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
  ]),
  describeIdentities: jest
    .fn()
    .mockResolvedValue(new Map([[MAILBOX_IDENTITY_ID, BUSINESS_DESCRIPTION]])),
};

describe('buildOwnMessagesExport, Task 13g G5', () => {
  it("keeps a blocked staff member's own messages and titles the thread with the business, with the customer's current name nowhere in the result", async () => {
    const { manager } = buildFakeManager([CONVERSATION_ID]);

    const exported = await buildOwnMessagesExport(
      manager,
      'staff-1',
      identities,
    );

    expect(exported).toHaveLength(1);
    expect(exported[0]!.conversationTitle).toBe('Acme Cafe');
    const serialized = JSON.stringify(exported);
    expect(serialized).toContain('your table is booked');
    expect(serialized).not.toContain('Renamed');
  });

  it("names the customer again once no block excludes the exporter's seat", async () => {
    const { manager } = buildFakeManager([]);

    const exported = await buildOwnMessagesExport(
      manager,
      'staff-1',
      identities,
    );

    expect(exported[0]!.conversationTitle).toBe('Jamie Renamed');
  });

  it("asks the shared block predicate about the exporter's own seat", async () => {
    const { manager, exclusionClauses } = buildFakeManager([]);

    await buildOwnMessagesExport(manager, 'staff-1', identities);

    expect(exclusionClauses).toContain(
      staffSeatExcludedFromMailboxPredicate(
        'export_seat.conversation_id',
        'export_seat.user_id',
      ),
    );
  });
});
