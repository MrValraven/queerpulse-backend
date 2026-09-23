import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import {
  isCoveredByMailboxStaffFloor,
  mailboxStaffHistoryFloorCoversPredicate,
} from './mailbox-seats';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13h, fix round 1: reaction, pin and star WRITES honour the history
 * floor of a mailbox staff seat. A co-manager seated when a personal thread
 * moved into a business mailbox holds a floor at its first enquiry. An
 * unavailable quote still carries its parent's id, so every write on a
 * pre-floor message is refused with the same 404 as a message outside the
 * conversation. A "clear chat" on a seat that speaks for the member themself
 * (a personal thread, the customer's own seat) keeps every write it had.
 *
 * The floor query runs against a fixture: the stand-in builder accepts only
 * the clauses it knows and answers the floor clause through its in-memory
 * twin, `isCoveredByMailboxStaffFloor`.
 */

const CONVERSATION_ID = 'c-thread';
const HISTORY_FLOOR = new Date('2026-09-10T12:00:00.000Z');
const PRE_FLOOR_MESSAGE_ID = 'm-pre-floor';
const POST_FLOOR_MESSAGE_ID = 'm-post-floor';
const STAFF_IDENTITY_ID = 'identity-listing';
const PROFILE_IDENTITY_ID = 'identity-profile';

const identityKindById = new Map<string, IdentityKind>([
  [STAFF_IDENTITY_ID, IdentityKind.Listing],
  [PROFILE_IDENTITY_ID, IdentityKind.Profile],
]);

const messageById = new Map<string, { id: string; createdAt: Date }>([
  [
    PRE_FLOOR_MESSAGE_ID,
    {
      id: PRE_FLOOR_MESSAGE_ID,
      createdAt: new Date('2026-09-10T11:00:00.000Z'),
    },
  ],
  [
    POST_FLOOR_MESSAGE_ID,
    {
      id: POST_FLOOR_MESSAGE_ID,
      createdAt: new Date('2026-09-10T13:00:00.000Z'),
    },
  ],
]);

const EXPECTED_FLOOR_CLAUSE = mailboxStaffHistoryFloorCoversPredicate(
  'message.created_at',
  'seat',
);

function callerSeat(identityId: string): ConversationParticipant {
  return {
    id: 'seat-caller',
    conversationId: CONVERSATION_ID,
    userId: 'caller',
    identityId,
    role: ConversationRole.Member,
    leftAt: null,
    clearedAt: HISTORY_FLOOR,
  } as unknown as ConversationParticipant;
}

function insertChain() {
  const chain = {
    insert: () => chain,
    into: () => chain,
    values: () => chain,
    orIgnore: () => chain,
    execute: jest.fn().mockResolvedValue({ raw: [{}] }),
  };
  return chain;
}

function build(seat: ConversationParticipant) {
  const floorQuery = () => {
    const parameters: Record<string, unknown> = {};
    const clauses: string[] = [];
    const builder = {
      withDeleted: () => builder,
      innerJoin: (
        _entity: unknown,
        _alias: string,
        _condition: string,
        joinParameters?: Record<string, unknown>,
      ) => {
        Object.assign(parameters, joinParameters);
        return builder;
      },
      where: (clause: string, whereParameters?: Record<string, unknown>) => {
        clauses.push(clause);
        Object.assign(parameters, whereParameters);
        return builder;
      },
      andWhere: (clause: string) => {
        clauses.push(clause);
        return builder;
      },
      getExists: () => {
        expect(parameters.callerSeatId).toBe(seat.id);
        const message = messageById.get(parameters.messageId as string);
        let isBelowFloor = Boolean(message);
        for (const clause of clauses) {
          if (clause === 'message.id = :messageId') {
            continue;
          } else if (clause === EXPECTED_FLOOR_CLAUSE) {
            isBelowFloor =
              isBelowFloor &&
              isCoveredByMailboxStaffFloor(message!.createdAt, {
                clearedAt: seat.clearedAt,
                identityKind: identityKindById.get(seat.identityId),
                isGroupConversation: false,
                isOfficialConversation: false,
              });
          } else {
            throw new Error(`Unrecognised floor clause: ${clause}`);
          }
        }
        return Promise.resolve(isBelowFloor);
      },
    };
    return builder;
  };
  const reactionInsert = insertChain();
  const pinInsert = insertChain();
  const starInsert = insertChain();
  const reactions = {
    createQueryBuilder: jest.fn(() => reactionInsert),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const pins = {
    exist: jest.fn().mockResolvedValue(false),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => pinInsert),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const stars = { createQueryBuilder: jest.fn(() => starInsert) };
  const core = {
    requireActiveParticipant: jest.fn().mockResolvedValue(seat),
    requireParticipant: jest.fn().mockResolvedValue(seat),
    assertMaySendAs: jest.fn().mockResolvedValue(undefined),
  };
  const service = new MessageAnnotationsService(
    {
      findOne: jest.fn().mockResolvedValue({ kind: ConversationKind.Direct }),
    } as unknown as Repository<Conversation>,
    {} as unknown as Repository<ConversationParticipant>,
    {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(messageById.get(where.id) ?? null),
      ),
      createQueryBuilder: jest.fn(floorQuery),
    } as unknown as Repository<Message>,
    reactions as unknown as Repository<MessageReaction>,
    pins as unknown as Repository<ConversationPinnedMessage>,
    stars as unknown as Repository<MessageStar>,
    {} as unknown as Repository<MessageHide>,
    {} as unknown as Repository<Profile>,
    core as unknown as MessagingCoreService,
    { emit: jest.fn() } as unknown as EventEmitter2,
  );
  jest
    .spyOn(
      service as unknown as { reactionCountsForMessage: () => Promise<[]> },
      'reactionCountsForMessage',
    )
    .mockResolvedValue([]);
  return { service, reactionInsert, pinInsert, starInsert, reactions, pins };
}

type Write = (
  service: MessageAnnotationsService,
  messageId: string,
) => Promise<unknown>;

const WRITES: Array<[string, Write]> = [
  [
    'react',
    (service, messageId) =>
      service.addMessageReaction(
        CONVERSATION_ID,
        messageId,
        'caller',
        MessageReactionKey.Love,
      ),
  ],
  [
    'remove a reaction',
    (service, messageId) =>
      service.removeMessageReaction(
        CONVERSATION_ID,
        messageId,
        'caller',
        MessageReactionKey.Love,
      ),
  ],
  [
    'pin',
    (service, messageId) =>
      service.pinMessage(CONVERSATION_ID, messageId, 'caller'),
  ],
  [
    'unpin',
    (service, messageId) =>
      service.unpinMessage(CONVERSATION_ID, messageId, 'caller'),
  ],
  [
    'star',
    (service, messageId) =>
      service.starMessage(CONVERSATION_ID, messageId, 'caller'),
  ],
];

describe('Task 13h: reaction, pin and star writes honour a mailbox staff floor', () => {
  it.each(WRITES)(
    'refuses a co-manager who tries to %s a pre-floor message, as a message outside the thread is refused',
    async (_label, write) => {
      const {
        service,
        reactionInsert,
        pinInsert,
        starInsert,
        reactions,
        pins,
      } = build(callerSeat(STAFF_IDENTITY_ID));

      await expect(write(service, PRE_FLOOR_MESSAGE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(reactionInsert.execute).not.toHaveBeenCalled();
      expect(pinInsert.execute).not.toHaveBeenCalled();
      expect(starInsert.execute).not.toHaveBeenCalled();
      expect(reactions.delete).not.toHaveBeenCalled();
      expect(pins.delete).not.toHaveBeenCalled();
    },
  );

  it.each(WRITES)(
    'lets the same co-manager %s a post-floor message',
    async (_label, write) => {
      const { service } = build(callerSeat(STAFF_IDENTITY_ID));

      await expect(write(service, POST_FLOOR_MESSAGE_ID)).resolves.toEqual({
        ok: true,
      });
    },
  );

  it.each(WRITES)(
    'still lets a member who cleared a chat from their own seat %s a cleared message, as before this task',
    async (_label, write) => {
      const { service } = build(callerSeat(PROFILE_IDENTITY_ID));

      await expect(write(service, PRE_FLOOR_MESSAGE_ID)).resolves.toEqual({
        ok: true,
      });
    },
  );
});
