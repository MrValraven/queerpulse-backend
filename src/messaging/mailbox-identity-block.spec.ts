import { ForbiddenException } from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import {
  describeDirectThreadSeats,
  isSeatExcludedFromMailbox,
  mailboxIdentityBlockKey,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 14: a member who blocks a business, persona or company severs every
 * thread between them and that mailbox, for both sides. Every read and write
 * refuses the customer's own seat and every staff seat of the business, as
 * it refuses a non-participant, and lifting the block gives both back.
 *
 * `requireParticipant` runs against a fixture. The stand-in participant
 * repository understands only the exclusion clause built by
 * `seatExcludedFromMailboxPredicate` and throws on any other, and it answers
 * that clause through its in-memory twin (`isSeatExcludedFromMailbox`), with
 * the person blocks and identity blocks the test holds, so the fixture
 * follows the shared rule.
 */

const BLOCKED_BUSINESS_THREAD = 'blocked-business-thread';
const OTHER_BUSINESS_THREAD = 'other-business-thread';

const CUSTOMER = 'customer-user';
const OWNER = 'owner-user';
const COLLEAGUE = 'colleague-user';

const CUSTOMER_IDENTITY = 'customer-identity';
const BLOCKED_BUSINESS_IDENTITY = 'blocked-business-identity';
const OTHER_BUSINESS_IDENTITY = 'other-business-identity';

const identityKindById = new Map<string, IdentityKind>([
  [CUSTOMER_IDENTITY, IdentityKind.Profile],
  [BLOCKED_BUSINESS_IDENTITY, IdentityKind.Listing],
  [OTHER_BUSINESS_IDENTITY, IdentityKind.Company],
]);

const EXPECTED_EXCLUSION_CLAUSE = seatExcludedFromMailboxPredicate(
  'seat.conversation_id',
  'seat.user_id',
);

function fixtureSeat(
  conversationId: string,
  userId: string,
  identityId: string,
): ConversationParticipant {
  return {
    id: `${conversationId}:${userId}`,
    conversationId,
    userId,
    identityId,
    leftAt: null,
    clearedAt: null,
  } as unknown as ConversationParticipant;
}

/** The owner answers for both businesses, and the colleague for the
 *  blocked one alone. */
const seats = [
  fixtureSeat(BLOCKED_BUSINESS_THREAD, CUSTOMER, CUSTOMER_IDENTITY),
  fixtureSeat(BLOCKED_BUSINESS_THREAD, OWNER, BLOCKED_BUSINESS_IDENTITY),
  fixtureSeat(BLOCKED_BUSINESS_THREAD, COLLEAGUE, BLOCKED_BUSINESS_IDENTITY),
  fixtureSeat(OTHER_BUSINESS_THREAD, CUSTOMER, CUSTOMER_IDENTITY),
  fixtureSeat(OTHER_BUSINESS_THREAD, OWNER, OTHER_BUSINESS_IDENTITY),
];

/** Read at query time, so a test can block and unblock between calls. */
interface BlockState {
  personBlockPairs: Array<[string, string]>;
  identityBlockPairs: Array<[string, string]>;
}

function isExcludedInFixture(
  state: BlockState,
  ownSeat: ConversationParticipant,
): boolean {
  const blockedUserIds = new Set<string>();
  for (const [blockerId, blockedId] of state.personBlockPairs) {
    if (blockerId === ownSeat.userId) blockedUserIds.add(blockedId);
    if (blockedId === ownSeat.userId) blockedUserIds.add(blockerId);
  }
  return isSeatExcludedFromMailbox(
    ownSeat,
    describeDirectThreadSeats(
      ownSeat.identityId,
      seats.filter(
        (seat) =>
          seat.conversationId === ownSeat.conversationId && seat !== ownSeat,
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

interface SeatQueryStandIn {
  where: jest.Mock;
  andWhere: jest.Mock;
  getExists: jest.Mock;
}

function buildCore(state: BlockState): MessagingCoreService {
  const participants = {
    findOne: jest.fn(
      ({ where }: { where: { conversationId: string; userId: string } }) =>
        Promise.resolve(
          seats.find(
            (seat) =>
              seat.conversationId === where.conversationId &&
              seat.userId === where.userId,
          ) ?? null,
        ),
    ),
    createQueryBuilder: jest.fn(() => {
      let seatId: string | undefined;
      let hasExclusionClause = false;
      const query: SeatQueryStandIn = {
        where: jest.fn((clause: string, parameters?: { seatId?: string }) => {
          if (clause !== 'seat.id = :seatId') {
            throw new Error(`Unrecognised seat clause: ${clause}`);
          }
          seatId = parameters?.seatId;
          return query;
        }),
        andWhere: jest.fn((clause: string) => {
          if (clause !== EXPECTED_EXCLUSION_CLAUSE) {
            throw new Error(`Unrecognised seat clause: ${clause}`);
          }
          hasExclusionClause = true;
          return query;
        }),
        getExists: jest.fn(() => {
          const ownSeat = seats.find((seat) => seat.id === seatId);
          return Promise.resolve(
            Boolean(ownSeat) &&
              hasExclusionClause &&
              isExcludedInFixture(state, ownSeat!),
          );
        }),
      };
      return query;
    }),
  };
  return Object.assign(Object.create(MessagingCoreService.prototype), {
    participants,
  }) as MessagingCoreService;
}

const STOP_AFTER_GATE = 'the read passed the participant gate';

function buildReaders(state: BlockState) {
  const core = buildCore(state);
  const conversations = Object.assign(
    Object.create(ConversationsService.prototype),
    { core },
  ) as ConversationsService;
  const messages = Object.assign(Object.create(MessagesService.prototype), {
    core,
    conversations: {
      findOne: jest.fn(() => Promise.reject(new Error(STOP_AFTER_GATE))),
    },
  }) as MessagesService;
  return { core, conversations, messages };
}

const refusal = new ForbiddenException('You are not a participant');

describe('Task 14: a block of a business severs its threads for both sides', () => {
  let state: BlockState;

  beforeEach(() => {
    state = {
      personBlockPairs: [],
      identityBlockPairs: [[CUSTOMER, BLOCKED_BUSINESS_IDENTITY]],
    };
  });

  it('refuses getConversation to the customer and to a staff member of the business', async () => {
    const { conversations } = buildReaders(state);

    for (const userId of [CUSTOMER, OWNER, COLLEAGUE]) {
      await expect(
        conversations.getConversation(BLOCKED_BUSINESS_THREAD, userId),
      ).rejects.toThrow(refusal);
    }
  });

  it('refuses the message history to the customer and to a staff member, before any history is read', async () => {
    const { messages } = buildReaders(state);

    for (const userId of [CUSTOMER, COLLEAGUE]) {
      await expect(
        messages.getMessages(BLOCKED_BUSINESS_THREAD, userId, {}),
      ).rejects.toThrow(refusal);
    }
  });

  it('refuses every write too, with the same answer', async () => {
    const { core } = buildReaders(state);

    await expect(
      core.requireActiveParticipant(BLOCKED_BUSINESS_THREAD, CUSTOMER),
    ).rejects.toThrow(refusal);
    await expect(
      core.requireActiveParticipant(BLOCKED_BUSINESS_THREAD, OWNER),
    ).rejects.toThrow(refusal);
  });

  it('gives both sides the thread back after the unblock', async () => {
    const { core, messages } = buildReaders(state);
    await expect(
      core.requireParticipant(BLOCKED_BUSINESS_THREAD, CUSTOMER),
    ).rejects.toThrow(refusal);

    state.identityBlockPairs = [];

    for (const userId of [CUSTOMER, OWNER, COLLEAGUE]) {
      await expect(
        core.requireParticipant(BLOCKED_BUSINESS_THREAD, userId),
      ).resolves.toMatchObject({ userId });
    }
    await expect(
      messages.getMessages(BLOCKED_BUSINESS_THREAD, CUSTOMER, {}),
    ).rejects.toThrow(STOP_AFTER_GATE);
  });

  it('leaves a thread with another business the same staff member works for open to both sides', async () => {
    const { core } = buildReaders(state);

    await expect(
      core.requireParticipant(BLOCKED_BUSINESS_THREAD, OWNER),
    ).rejects.toThrow(refusal);

    await expect(
      core.requireParticipant(OTHER_BUSINESS_THREAD, CUSTOMER),
    ).resolves.toMatchObject({ userId: CUSTOMER });
    await expect(
      core.requireParticipant(OTHER_BUSINESS_THREAD, OWNER),
    ).resolves.toMatchObject({ userId: OWNER });
  });

  it("leaves the business thread open to the customer who blocked only the business's owner as a person", async () => {
    state.identityBlockPairs = [];
    state.personBlockPairs = [[CUSTOMER, OWNER]];
    const { core } = buildReaders(state);

    await expect(
      core.requireParticipant(BLOCKED_BUSINESS_THREAD, CUSTOMER),
    ).resolves.toMatchObject({ userId: CUSTOMER });
    await expect(
      core.requireParticipant(BLOCKED_BUSINESS_THREAD, COLLEAGUE),
    ).resolves.toMatchObject({ userId: COLLEAGUE });
    await expect(
      core.requireParticipant(BLOCKED_BUSINESS_THREAD, OWNER),
    ).rejects.toThrow(refusal);

    state.identityBlockPairs = [[CUSTOMER, BLOCKED_BUSINESS_IDENTITY]];
    await expect(
      core.requireParticipant(BLOCKED_BUSINESS_THREAD, CUSTOMER),
    ).rejects.toThrow(refusal);
  });
});
