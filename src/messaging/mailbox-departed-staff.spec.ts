import { ForbiddenException } from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';
import {
  describeDirectThreadSeats,
  isSeatExcludedFromMailbox,
  NO_MAILBOX_IDENTITY_BLOCKS,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 14a: a staff member who leaves a business keeps their seat row in
 * every thread of its mailbox, with `leftAt` stamped, and that seat has no
 * access at all: every read and write refuses it exactly as it refuses a
 * non-participant. A member who left a group keeps reading its history up to
 * the moment they left, as before.
 *
 * `requireParticipant` runs against a fixture. The stand-in participant
 * repository understands only the exclusion clause built by
 * `seatExcludedFromMailboxPredicate` (Task 14) and throws on any other, and
 * it answers that clause through its in-memory twin
 * (`isSeatExcludedFromMailbox`), limited to direct, non-official
 * threads as the SQL is, so the fixture follows the shared rule.
 */

const MAILBOX_THREAD = 'mailbox-thread';
const GROUP_THREAD = 'group-thread';

const CUSTOMER = 'customer-user';
const DEPARTED_STAFF = 'departed-staff-user';
const COLLEAGUE = 'colleague-user';
const GROUP_LEAVER = 'group-leaver-user';
const GROUP_MEMBER = 'group-member-user';

const CUSTOMER_IDENTITY = 'customer-identity';
const MAILBOX_IDENTITY = 'mailbox-identity';
const GROUP_LEAVER_IDENTITY = 'group-leaver-identity';
const GROUP_MEMBER_IDENTITY = 'group-member-identity';

const LEFT_AT = new Date('2026-09-20T12:00:00.000Z');

const identityKindById = new Map<string, IdentityKind>([
  [CUSTOMER_IDENTITY, IdentityKind.Profile],
  [MAILBOX_IDENTITY, IdentityKind.Listing],
  [GROUP_LEAVER_IDENTITY, IdentityKind.Profile],
  [GROUP_MEMBER_IDENTITY, IdentityKind.Profile],
]);

const conversationKindById = new Map<string, ConversationKind>([
  [MAILBOX_THREAD, ConversationKind.Direct],
  [GROUP_THREAD, ConversationKind.Group],
]);

const EXPECTED_EXCLUSION_CLAUSE = seatExcludedFromMailboxPredicate(
  'seat.conversation_id',
  'seat.user_id',
);

function fixtureSeat(
  conversationId: string,
  userId: string,
  identityId: string,
  leftAt: Date | null = null,
): ConversationParticipant {
  return {
    id: `${conversationId}:${userId}`,
    conversationId,
    userId,
    identityId,
    leftAt,
    clearedAt: null,
  } as unknown as ConversationParticipant;
}

/** The seats of both threads. `leftAt` is read at query time, so a test can
 *  seat a departed staff member again between two calls. */
function buildSeats(): ConversationParticipant[] {
  return [
    fixtureSeat(MAILBOX_THREAD, CUSTOMER, CUSTOMER_IDENTITY),
    fixtureSeat(MAILBOX_THREAD, DEPARTED_STAFF, MAILBOX_IDENTITY, LEFT_AT),
    fixtureSeat(MAILBOX_THREAD, COLLEAGUE, MAILBOX_IDENTITY),
    fixtureSeat(GROUP_THREAD, GROUP_LEAVER, GROUP_LEAVER_IDENTITY, LEFT_AT),
    fixtureSeat(GROUP_THREAD, GROUP_MEMBER, GROUP_MEMBER_IDENTITY),
  ];
}

function isExcludedInFixture(
  seats: ReadonlyArray<ConversationParticipant>,
  ownSeat: ConversationParticipant,
): boolean {
  if (
    conversationKindById.get(ownSeat.conversationId) === ConversationKind.Group
  ) {
    return false;
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
    new Set<string>(),
    NO_MAILBOX_IDENTITY_BLOCKS,
  );
}

interface SeatQueryStandIn {
  where: jest.Mock;
  andWhere: jest.Mock;
  getExists: jest.Mock;
}

function buildParticipantsFixture(seats: ConversationParticipant[]) {
  const recordedClauses: string[] = [];
  return {
    recordedClauses,
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
      const clauses: string[] = [];
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
          clauses.push(clause);
          recordedClauses.push(clause);
          return query;
        }),
        getExists: jest.fn(() => {
          const ownSeat = seats.find((seat) => seat.id === seatId);
          return Promise.resolve(
            Boolean(ownSeat) &&
              clauses.length === 1 &&
              isExcludedInFixture(seats, ownSeat!),
          );
        }),
      };
      return query;
    }),
  };
}

function buildCore(seats: ConversationParticipant[]) {
  const participants = buildParticipantsFixture(seats);
  const core = Object.assign(Object.create(MessagingCoreService.prototype), {
    participants,
  }) as MessagingCoreService;
  return { core, participants };
}

const STOP_AFTER_GATE = 'the read passed the participant gate';

/** A message query that records its clauses and stops at its first read,
 *  so a test can see which ceiling the history read applies. */
function recordingMessageQuery(clauses: string[]): unknown {
  const query: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return undefined;
        }
        if (typeof property === 'string' && property.startsWith('get')) {
          return () => Promise.reject(new Error(STOP_AFTER_GATE));
        }
        return (clause?: unknown) => {
          if (property === 'andWhere' && typeof clause === 'string') {
            clauses.push(clause);
          }
          return query;
        };
      },
    },
  );
  return query;
}

function buildMessagesService(
  core: MessagingCoreService,
  conversationKind: ConversationKind,
) {
  const messageClauses: string[] = [];
  const service = Object.assign(Object.create(MessagesService.prototype), {
    core,
    conversations: {
      findOne: jest.fn().mockResolvedValue({ kind: conversationKind }),
    },
    messages: {
      createQueryBuilder: jest.fn(() => recordingMessageQuery(messageClauses)),
    },
    blockFilter: { excludeBlocked: jest.fn() },
  }) as MessagesService;
  return { service, messageClauses };
}

describe('Task 14a: every read and write refuses a departed staff seat', () => {
  it('refuses the departed staff member as it refuses a non-participant', async () => {
    const { core } = buildCore(buildSeats());

    await expect(
      core.requireParticipant(MAILBOX_THREAD, DEPARTED_STAFF),
    ).rejects.toThrow(new ForbiddenException('You are not a participant'));
    await expect(
      core.requireParticipant(MAILBOX_THREAD, 'stranger-user'),
    ).rejects.toThrow(new ForbiddenException('You are not a participant'));
  });

  it('keeps the live colleague and the customer', async () => {
    const { core } = buildCore(buildSeats());

    await expect(
      core.requireParticipant(MAILBOX_THREAD, COLLEAGUE),
    ).resolves.toMatchObject({ userId: COLLEAGUE });
    await expect(
      core.requireParticipant(MAILBOX_THREAD, CUSTOMER),
    ).resolves.toMatchObject({ userId: CUSTOMER });
  });

  it('keeps the group leaver on their row, leftAt and all', async () => {
    const { core } = buildCore(buildSeats());

    await expect(
      core.requireParticipant(GROUP_THREAD, GROUP_LEAVER),
    ).resolves.toMatchObject({ userId: GROUP_LEAVER, leftAt: LEFT_AT });
  });

  it('refuses every write too, with the same answer', async () => {
    const { core } = buildCore(buildSeats());

    await expect(
      core.requireActiveParticipant(MAILBOX_THREAD, DEPARTED_STAFF),
    ).rejects.toThrow(new ForbiddenException('You are not a participant'));
  });

  it('asks the database through the one shared exclusion rule', async () => {
    const { core, participants } = buildCore(buildSeats());

    await core.requireParticipant(MAILBOX_THREAD, COLLEAGUE);

    expect(participants.recordedClauses).toEqual([EXPECTED_EXCLUSION_CLAUSE]);
  });

  it('refuses getConversation to the departed staff member', async () => {
    const { core } = buildCore(buildSeats());
    const conversations = Object.assign(
      Object.create(ConversationsService.prototype),
      { core },
    ) as ConversationsService;

    await expect(
      conversations.getConversation(MAILBOX_THREAD, DEPARTED_STAFF),
    ).rejects.toThrow(new ForbiddenException('You are not a participant'));
  });

  it('refuses getMessages to the departed staff member, before any history is read', async () => {
    const { core } = buildCore(buildSeats());
    const { service, messageClauses } = buildMessagesService(
      core,
      ConversationKind.Direct,
    );

    await expect(
      service.getMessages(MAILBOX_THREAD, DEPARTED_STAFF, {}),
    ).rejects.toThrow(new ForbiddenException('You are not a participant'));
    expect(messageClauses).toEqual([]);
  });

  it('still serves the group leaver their history, ceilinged at the moment they left', async () => {
    const { core } = buildCore(buildSeats());
    const { service, messageClauses } = buildMessagesService(
      core,
      ConversationKind.Group,
    );

    await expect(
      service.getMessages(GROUP_THREAD, GROUP_LEAVER, {}),
    ).rejects.toThrow(STOP_AFTER_GATE);
    expect(messageClauses).toContain('m.created_at <= :leftAt');
  });

  it('restores access once the staff member is seated again', async () => {
    const seats = buildSeats();
    const { core } = buildCore(seats);
    const departedSeat = seats.find((seat) => seat.userId === DEPARTED_STAFF)!;

    await expect(
      core.requireParticipant(MAILBOX_THREAD, DEPARTED_STAFF),
    ).rejects.toThrow(ForbiddenException);
    departedSeat.leftAt = null;
    await expect(
      core.requireParticipant(MAILBOX_THREAD, DEPARTED_STAFF),
    ).resolves.toMatchObject({ userId: DEPARTED_STAFF });
  });
});
