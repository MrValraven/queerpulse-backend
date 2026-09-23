import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import {
  DocumentAttachment,
  GifAttachment,
  Message,
} from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import {
  describeDirectThreadSeats,
  isCoveredByMailboxStaffFloor,
  isSeatExcludedFromMailbox,
  mailboxStaffHistoryFloorCoversPredicate,
  NO_MAILBOX_IDENTITY_BLOCKS,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13g, audit gap G1: forwarding an attachment re-serves its bytes to
 * everyone in the destination thread, so the proof that a sender may forward
 * one has to apply the block rule and the departed-staff rule to the seat
 * that saw it.
 *
 * The query runs against a fixture. The stand-in builder below understands
 * only the clauses it was told about and throws on any other, and it reads
 * the exclusion clause through the in-memory twin of
 * `seatExcludedFromMailboxPredicate` (`isSeatExcludedFromMailbox`), so the
 * fixture answers exactly as the shared rule does. Task 14a: that one
 * clause carries both the block rule and the departed-staff rule, so the
 * forward holds no copy of either. Task 14: it carries the identity block
 * too, which these fixtures leave empty.
 */

const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const BLOCKED_STAFF = '22222222-2222-2222-2222-222222222222';
const COLLEAGUE = '44444444-4444-4444-4444-444444444444';
const DEPARTED_STAFF = '55555555-5555-5555-5555-555555555555';
const FRIEND = '66666666-6666-6666-6666-666666666666';
const FLOORED_STAFF = '88888888-8888-8888-8888-888888888888';
// A co-manager of the moved thread with no history floor, who cleared the
// thread for themself.
const CLEARING_STAFF = '8888cccc-8888-8888-8888-888888888888';
const OWNER = '99999999-9999-9999-9999-999999999999';
const ASSET = '33333333-3333-3333-3333-333333333333';

const CUSTOMER_IDENTITY = 'customer-identity';
const FRIEND_IDENTITY = 'friend-identity';
const MAILBOX_IDENTITY = 'mailbox-identity';

const MAILBOX_THREAD = 'mailbox-thread';
const PERSONAL_THREAD = 'personal-thread';
const LEFT_GROUP = 'left-group';

const identityKindById = new Map<string, IdentityKind>([
  [CUSTOMER_IDENTITY, IdentityKind.Profile],
  [FRIEND_IDENTITY, IdentityKind.Profile],
  [`${BLOCKED_STAFF}-identity`, IdentityKind.Profile],
  [MAILBOX_IDENTITY, IdentityKind.Listing],
]);

const customerImageKey = `message-images/${CUSTOMER}/${ASSET}.jpg`;
const customerDocumentKey = `message-documents/${CUSTOMER}/${ASSET}.pdf`;
const friendImageKey = `message-images/${FRIEND}/${ASSET}.jpg`;
const staffImageKey = `message-images/${COLLEAGUE}/${ASSET}.jpg`;
const groupImageKey = `message-images/${COLLEAGUE}/77777777-7777-7777-7777-777777777777.jpg`;
// Task 13h: a moved business thread, where the co-manager's history floor
// sits at the first enquiry. The customer's private photo predates it, and
// their photo after the enquiry follows it.
const MOVED_THREAD = 'moved-thread';
const HISTORY_FLOOR = new Date('2026-09-10T12:00:00.000Z');
const preFloorImageKey = `message-images/${CUSTOMER}/99999999-9999-9999-9999-999999999991.jpg`;
const postFloorImageKey = `message-images/${CUSTOMER}/99999999-9999-9999-9999-999999999992.jpg`;
// Fix round 1: a personal thread the friend cleared at the same instant.
const CLEARED_PERSONAL_THREAD = 'cleared-personal-thread';
const clearedPersonalImageKey = `message-images/${CUSTOMER}/99999999-9999-9999-9999-999999999993.jpg`;

interface FixtureSeat {
  conversationId: string;
  userId: string;
  identityId: string;
  leftAt: Date | null;
  clearedAt?: Date | null;
  historyFloorAt?: Date | null;
}

interface FixtureMessage {
  conversationId: string;
  kind: string;
  url: string;
  createdAt?: Date;
}

const seats: FixtureSeat[] = [
  {
    conversationId: MAILBOX_THREAD,
    userId: CUSTOMER,
    identityId: CUSTOMER_IDENTITY,
    leftAt: null,
  },
  {
    conversationId: MAILBOX_THREAD,
    userId: BLOCKED_STAFF,
    identityId: MAILBOX_IDENTITY,
    leftAt: null,
  },
  {
    conversationId: MAILBOX_THREAD,
    userId: COLLEAGUE,
    identityId: MAILBOX_IDENTITY,
    leftAt: null,
  },
  {
    conversationId: MAILBOX_THREAD,
    userId: DEPARTED_STAFF,
    identityId: MAILBOX_IDENTITY,
    leftAt: new Date('2026-09-01T00:00:00.000Z'),
  },
  // An ordinary DM between the blocked staff member, as themself, and a
  // friend: the block with the customer has no bearing on it.
  {
    conversationId: PERSONAL_THREAD,
    userId: BLOCKED_STAFF,
    identityId: `${BLOCKED_STAFF}-identity`,
    leftAt: null,
  },
  {
    conversationId: PERSONAL_THREAD,
    userId: FRIEND,
    identityId: FRIEND_IDENTITY,
    leftAt: null,
  },
  // A group the friend left: a seat that speaks for the member themself
  // keeps its allowance to forward what it saw there.
  {
    conversationId: LEFT_GROUP,
    userId: FRIEND,
    identityId: FRIEND_IDENTITY,
    leftAt: new Date('2026-09-01T00:00:00.000Z'),
  },
  {
    conversationId: MOVED_THREAD,
    userId: CUSTOMER,
    identityId: CUSTOMER_IDENTITY,
    leftAt: null,
  },
  {
    conversationId: MOVED_THREAD,
    userId: OWNER,
    identityId: MAILBOX_IDENTITY,
    leftAt: null,
  },
  {
    conversationId: MOVED_THREAD,
    userId: FLOORED_STAFF,
    identityId: MAILBOX_IDENTITY,
    leftAt: null,
    clearedAt: HISTORY_FLOOR,
    historyFloorAt: HISTORY_FLOOR,
  },
  {
    conversationId: MOVED_THREAD,
    userId: CLEARING_STAFF,
    identityId: MAILBOX_IDENTITY,
    leftAt: null,
    clearedAt: HISTORY_FLOOR,
  },
  {
    conversationId: CLEARED_PERSONAL_THREAD,
    userId: CUSTOMER,
    identityId: CUSTOMER_IDENTITY,
    leftAt: null,
  },
  {
    conversationId: CLEARED_PERSONAL_THREAD,
    userId: FRIEND,
    identityId: FRIEND_IDENTITY,
    leftAt: null,
    clearedAt: HISTORY_FLOOR,
  },
];

const messages: FixtureMessage[] = [
  { conversationId: MAILBOX_THREAD, kind: 'image', url: customerImageKey },
  {
    conversationId: MAILBOX_THREAD,
    kind: 'document',
    url: customerDocumentKey,
  },
  { conversationId: PERSONAL_THREAD, kind: 'image', url: friendImageKey },
  { conversationId: LEFT_GROUP, kind: 'image', url: groupImageKey },
  { conversationId: MAILBOX_THREAD, kind: 'image', url: staffImageKey },
  {
    conversationId: MOVED_THREAD,
    kind: 'image',
    url: preFloorImageKey,
    createdAt: new Date('2026-09-10T11:00:00.000Z'),
  },
  {
    conversationId: MOVED_THREAD,
    kind: 'image',
    url: postFloorImageKey,
    createdAt: new Date('2026-09-10T13:00:00.000Z'),
  },
  {
    conversationId: CLEARED_PERSONAL_THREAD,
    kind: 'image',
    url: clearedPersonalImageKey,
    createdAt: new Date('2026-09-10T11:00:00.000Z'),
  },
];

const EXPECTED_HISTORY_FLOOR_CLAUSE = `NOT ${mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'participant')}`;

const EXPECTED_EXCLUSION_CLAUSE = `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':senderId')}`;

/**
 * CW-20 (task-13g-review.md finding M1): `EXPECTED_EXCLUSION_CLAUSE` above is
 * built by calling the very same production function the query builder
 * calls, so a regression inside `seatExcludedFromMailboxPredicate` itself
 * (or the predicates it composes) would still make that string comparison
 * pass, since both sides recompute from the same, now-wrong, source. There
 * is no database harness in this suite to execute the generated `EXISTS`
 * subqueries and check the answer the way the reviewer did by hand against a
 * throwaway Postgres, so this list pins the fragments that check by hand
 * against `mailbox-seats.ts`, independently of any call into it. Losing one
 * of these (a swapped block direction, a dropped group/official guard, a
 * missing OR arm) changes the generated SQL text and fails here even though
 * nothing below ever runs it.
 */
const LOAD_BEARING_EXCLUSION_FRAGMENTS = [
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
] as const;

/** Every user blocked either way with `userId`, as `blockedUserIds` reads it. */
function blockedEitherWayWith(
  userId: string,
  blockPairs: ReadonlyArray<[string, string]>,
): Set<string> {
  const blocked = new Set<string>();
  for (const [blockerId, blockedId] of blockPairs) {
    if (blockerId === userId) blocked.add(blockedId);
    if (blockedId === userId) blocked.add(blockerId);
  }
  return blocked;
}

interface ForwardQueryStub {
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  getCount: jest.Mock;
}

function buildForwardFixtureQuery(blockPairs: ReadonlyArray<[string, string]>) {
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  const builder: ForwardQueryStub = {
    innerJoin: jest.fn(
      (
        _entity: unknown,
        _alias: string,
        _condition: string,
        joinParameters?: Record<string, unknown>,
      ) => {
        Object.assign(parameters, joinParameters);
        return builder;
      },
    ),
    where: jest.fn(
      (clause: string, whereParameters?: Record<string, unknown>) => {
        clauses.push(clause);
        Object.assign(parameters, whereParameters);
        return builder;
      },
    ),
    andWhere: jest.fn(
      (clause: string, whereParameters?: Record<string, unknown>) => {
        clauses.push(clause);
        Object.assign(parameters, whereParameters);
        return builder;
      },
    ),
    getCount: jest.fn(() => {
      const senderId = parameters.senderId as string;
      let rows = messages.flatMap((message) =>
        seats
          .filter(
            (seat) =>
              seat.conversationId === message.conversationId &&
              seat.userId === senderId,
          )
          .map((seat) => ({ message, seat })),
      );
      for (const clause of clauses) {
        if (clause === 'message.kind = :attachmentKind') {
          rows = rows.filter(
            ({ message }) => message.kind === parameters.attachmentKind,
          );
        } else if (clause === "message.attachment ->> 'url' = :attachmentKey") {
          rows = rows.filter(
            ({ message }) => message.url === parameters.attachmentKey,
          );
        } else if (clause === EXPECTED_EXCLUSION_CLAUSE) {
          const blockedUserIds = blockedEitherWayWith(senderId, blockPairs);
          rows = rows.filter(
            ({ seat }) =>
              !isSeatExcludedFromMailbox(
                seat,
                describeDirectThreadSeats(
                  seat.identityId,
                  seats.filter(
                    (other) =>
                      other.conversationId === seat.conversationId &&
                      other !== seat,
                  ) as ConversationParticipant[],
                  identityKindById,
                ),
                blockedUserIds,
                NO_MAILBOX_IDENTITY_BLOCKS,
              ),
          );
        } else if (clause === EXPECTED_HISTORY_FLOOR_CLAUSE) {
          rows = rows.filter(
            ({ message, seat }) =>
              !message.createdAt ||
              !isCoveredByMailboxStaffFloor(message.createdAt, {
                historyFloorAt: seat.historyFloorAt,
                identityKind: identityKindById.get(seat.identityId),
                isGroupConversation: seat.conversationId === LEFT_GROUP,
                isOfficialConversation: false,
              }),
          );
        } else {
          throw new Error(`Unrecognised forward clause: ${clause}`);
        }
      }
      return Promise.resolve(rows.length);
    }),
  };
  return { builder, clauses, parameters };
}

function build(blockPairs: ReadonlyArray<[string, string]> = []) {
  const { builder, clauses, parameters } = buildForwardFixtureQuery(blockPairs);
  const messageRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn(() => builder),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: Record<string, unknown>) =>
      Promise.resolve({ id: 'saved-message-id', ...entity }),
    ),
  };
  const destinationIdentityId = 'destination-identity';
  const participants = {
    find: jest.fn().mockResolvedValue([{ identityId: destinationIdentityId }]),
    // CW-05: `assertMaySendAs` now asks for the sender's own seat directly
    // through `exist`, an existence check on the exact pair it needs.
    exist: jest.fn().mockResolvedValue(true),
  };
  const identities = {
    resolveProfileIdentityId: jest
      .fn()
      .mockResolvedValue(destinationIdentityId),
    assertMayActAs: jest.fn().mockResolvedValue(undefined),
  };
  const empty = {} as Record<string, never>;
  const service = new MessagingCoreService(
    empty as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    messageRepository as unknown as Repository<Message>,
    empty as unknown as Repository<MessageReaction>,
    empty as unknown as Repository<ConversationPinnedMessage>,
    empty as unknown as Repository<MessageStar>,
    empty as unknown as Repository<MessageHide>,
    empty as unknown as Repository<ContentModeration>,
    empty as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    empty as unknown as UsersService,
    identities as unknown as IdentitiesService,
    {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    } as unknown as IdentityAttributionService,
  );
  const buildPostResult = jest
    .spyOn(service, 'buildPostResult')
    .mockResolvedValue({
      view: {} as never,
      response: {} as never,
      isNew: true,
    });
  return { service, buildPostResult, clauses, parameters };
}

function imageAttachment(key: string): GifAttachment {
  return {
    url: key,
    previewUrl: key,
    width: 10,
    height: 10,
    provider: 'upload',
  };
}

function documentAttachment(key: string): DocumentAttachment {
  return {
    url: key,
    fileName: 'booking.pdf',
    byteSize: 1024,
    contentType: 'application/pdf',
    provider: 'upload',
  };
}

function forwardImage(
  service: MessagingCoreService,
  senderId: string,
  key: string,
) {
  return service.postMessage(
    'destination-thread',
    senderId,
    'forwarding this',
    undefined,
    undefined,
    true,
    'image',
    imageAttachment(key),
  );
}

function forwardDocument(
  service: MessagingCoreService,
  senderId: string,
  key: string,
) {
  return service.postMessage(
    'destination-thread',
    senderId,
    'forwarding this',
    undefined,
    undefined,
    true,
    'document',
    documentAttachment(key),
  );
}

describe('Task 13g G1: forwarding an attachment applies the block rule and the departed-staff rule', () => {
  it("refuses a staff member the customer blocked when they forward the customer's image", async () => {
    const { service, buildPostResult } = build([[CUSTOMER, BLOCKED_STAFF]]);

    await expect(
      forwardImage(service, BLOCKED_STAFF, customerImageKey),
    ).rejects.toThrow(ForbiddenException);
    expect(buildPostResult).not.toHaveBeenCalled();
  });

  it("refuses a staff member the customer blocked when they forward the customer's document", async () => {
    const { service, buildPostResult } = build([[CUSTOMER, BLOCKED_STAFF]]);

    await expect(
      forwardDocument(service, BLOCKED_STAFF, customerDocumentKey),
    ).rejects.toThrow(ForbiddenException);
    expect(buildPostResult).not.toHaveBeenCalled();
  });

  it('refuses a staff member who blocked the customer, the other direction of the same rule', async () => {
    const { service } = build([[BLOCKED_STAFF, CUSTOMER]]);

    await expect(
      forwardImage(service, BLOCKED_STAFF, customerImageKey),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses a departed staff member forwarding a customer's image or document", async () => {
    const { service, buildPostResult } = build();

    await expect(
      forwardImage(service, DEPARTED_STAFF, customerImageKey),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      forwardDocument(service, DEPARTED_STAFF, customerDocumentKey),
    ).rejects.toThrow(ForbiddenException);
    expect(buildPostResult).not.toHaveBeenCalled();
  });

  it('lets an unblocked colleague forward the same image and document', async () => {
    const { service, buildPostResult } = build([[CUSTOMER, BLOCKED_STAFF]]);

    await forwardImage(service, COLLEAGUE, customerImageKey);
    await forwardDocument(service, COLLEAGUE, customerDocumentKey);

    expect(buildPostResult).toHaveBeenCalledTimes(2);
  });

  it('lets the customer forward an image the business sent them, block or no block', async () => {
    const { service, buildPostResult } = build([[CUSTOMER, BLOCKED_STAFF]]);

    await forwardImage(service, CUSTOMER, staffImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary personal-thread forwarding unchanged for the blocked staff member', async () => {
    const { service, buildPostResult } = build([[CUSTOMER, BLOCKED_STAFF]]);

    await forwardImage(service, BLOCKED_STAFF, friendImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it('keeps the allowance of a member who left a group, whose seat speaks for themself', async () => {
    const { service, buildPostResult } = build();

    await forwardImage(service, FRIEND, groupImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it("binds the block clause to the sender's own seat in the source conversation", async () => {
    const { service, clauses, parameters } = build();

    await forwardImage(service, COLLEAGUE, customerImageKey);

    expect(clauses).toContain(EXPECTED_EXCLUSION_CLAUSE);
    expect(parameters.senderId).toBe(COLLEAGUE);
  });

  it("Task 13h: refuses a co-manager forwarding a customer's photo from before their history floor", async () => {
    const { service, buildPostResult } = build();

    await expect(
      forwardImage(service, FLOORED_STAFF, preFloorImageKey),
    ).rejects.toThrow(ForbiddenException);
    expect(buildPostResult).not.toHaveBeenCalled();
  });

  it("Task 13h: lets the same co-manager forward the customer's photo from after the floor", async () => {
    const { service, buildPostResult } = build();

    await forwardImage(service, FLOORED_STAFF, postFloorImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it('Task 13h: lets the owner, who holds no floor, forward the photo from before it', async () => {
    const { service, buildPostResult } = build();

    await forwardImage(service, OWNER, preFloorImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it("lets a co-manager whose own clear chat covers the customer's photo, with no history floor, forward it", async () => {
    const { service, buildPostResult } = build();

    await forwardImage(service, CLEARING_STAFF, preFloorImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it('Task 13h: keeps the forward allowance of a personal-thread member who cleared the chat, as before this task', async () => {
    const { service, buildPostResult } = build();

    await forwardImage(service, FRIEND, clearedPersonalImageKey);

    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it('Task 13h: compares the staff-scoped floor inclusively in SQL, at the seat of the source conversation', () => {
    expect(EXPECTED_HISTORY_FLOOR_CLAUSE).toContain(
      'message.created_at <= participant.history_floor_at',
    );
    expect(EXPECTED_HISTORY_FLOOR_CLAUSE).not.toContain('cleared_at');
    expect(EXPECTED_HISTORY_FLOOR_CLAUSE).toContain(
      `"floor_staff_identity"."kind" <> 'profile'`,
    );
    expect(EXPECTED_HISTORY_FLOOR_CLAUSE).toContain(
      '"floor_staff_identity"."id" = participant.identity_id',
    );
  });

  // CW-20 (M1): see LOAD_BEARING_EXCLUSION_FRAGMENTS's own comment. This is
  // the closest this suite gets, with no database to run the SQL against, to
  // a check with teeth against a semantically wrong clause, catching it even
  // though the self-computed string comparison above stays blind to it.
  it('carries every load-bearing block-direction and identity-kind guard the SQL depends on', () => {
    for (const fragment of LOAD_BEARING_EXCLUSION_FRAGMENTS) {
      expect(EXPECTED_EXCLUSION_CLAUSE).toContain(fragment);
    }
  });
});
