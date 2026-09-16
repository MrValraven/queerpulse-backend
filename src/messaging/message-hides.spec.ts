import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

const CONVERSATION_ID = 'c1';
const MESSAGE_ID = 'm1';
const VIEWER_ID = 'viewer';
const OTHER_PARTICIPANT_ID = 'other';

/**
 * Chainable stand-in for the `INSERT ... ON CONFLICT DO NOTHING` builder the
 * hide write runs. Every builder method returns the same object; `execute` is
 * the terminal awaited call.
 */
interface InsertQueryMock {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  execute: jest.Mock;
}

function makeInsertQuery(): InsertQueryMock {
  const query = {} as InsertQueryMock;
  const self = (): InsertQueryMock => query;
  query.insert = jest.fn(self);
  query.into = jest.fn(self);
  query.values = jest.fn(self);
  query.orIgnore = jest.fn(self);
  query.execute = jest.fn().mockResolvedValue({ identifiers: [], raw: [] });
  return query;
}

describe('MessageAnnotationsService.hideMessageForMe (PRD-227)', () => {
  let service: MessageAnnotationsService;
  let messages: { findOne: jest.Mock };
  let hides: { createQueryBuilder: jest.Mock };
  let core: {
    requireParticipant: jest.Mock;
    requireActiveParticipant: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let insertQuery: InsertQueryMock;

  beforeEach(() => {
    insertQuery = makeInsertQuery();
    messages = {
      findOne: jest.fn().mockResolvedValue({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: OTHER_PARTICIPANT_ID,
        deletedAt: null,
      }),
    };
    hides = { createQueryBuilder: jest.fn(() => insertQuery) };
    core = {
      requireParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        clearedAt: null,
        leftAt: null,
      }),
      // Hiding is self-service on the lenient check; reaching the strict one
      // at all would be a regression.
      requireActiveParticipant: jest
        .fn()
        .mockRejectedValue(
          new Error('hideMessageForMe must not use the write-path check'),
        ),
    };
    eventEmitter = { emit: jest.fn() };
    service = new MessageAnnotationsService(
      {} as Repository<Conversation>,
      {} as Repository<ConversationParticipant>,
      messages as unknown as Repository<Message>,
      {} as Repository<MessageReaction>,
      {} as Repository<ConversationPinnedMessage>,
      {} as Repository<MessageStar>,
      hides as unknown as Repository<MessageHide>,
      {} as Repository<Profile>,
      core as unknown as MessagingCoreService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  it("records the hide under the caller's own id, idempotently, for a message someone else sent", async () => {
    await expect(
      service.hideMessageForMe(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).resolves.toEqual({ ok: true });

    expect(core.requireParticipant).toHaveBeenCalledWith(
      CONVERSATION_ID,
      VIEWER_ID,
    );
    expect(insertQuery.into).toHaveBeenCalledWith(MessageHide);
    expect(insertQuery.values).toHaveBeenCalledWith({
      userId: VIEWER_ID,
      messageId: MESSAGE_ID,
    });
    // ON CONFLICT DO NOTHING: a repeat hide is a no-op success.
    expect(insertQuery.orIgnore).toHaveBeenCalled();
    expect(insertQuery.execute).toHaveBeenCalled();
  });

  it('emits no event, so no other participant can observe the hide', async () => {
    await service.hideMessageForMe(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('stays open to a member who has left the group', async () => {
    core.requireParticipant.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      clearedAt: null,
      leftAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    await expect(
      service.hideMessageForMe(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).resolves.toEqual({ ok: true });
    expect(core.requireActiveParticipant).not.toHaveBeenCalled();
    expect(insertQuery.values).toHaveBeenCalledWith({
      userId: VIEWER_ID,
      messageId: MESSAGE_ID,
    });
  });

  it('refuses a non-participant before looking up the message or writing', async () => {
    core.requireParticipant.mockRejectedValue(
      new ForbiddenException('You are not a participant'),
    );

    await expect(
      service.hideMessageForMe(CONVERSATION_ID, MESSAGE_ID, 'stranger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(messages.findOne).not.toHaveBeenCalled();
    expect(hides.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('looks the message up inside this conversation with tombstones included, so a deleted placeholder can be hidden', async () => {
    messages.findOne.mockResolvedValue({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: OTHER_PARTICIPANT_ID,
      deletedAt: new Date('2026-09-02T10:00:00.000Z'),
    });

    await expect(
      service.hideMessageForMe(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).resolves.toEqual({ ok: true });
    expect(messages.findOne).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID, conversationId: CONVERSATION_ID },
      withDeleted: true,
    });
  });

  it('404s a message that does not live in this conversation and writes nothing', async () => {
    messages.findOne.mockResolvedValue(null);

    await expect(
      service.hideMessageForMe(
        CONVERSATION_ID,
        'message-in-another-thread',
        VIEWER_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(hides.createQueryBuilder).not.toHaveBeenCalled();
  });
});

/**
 * The read side of the same rule: a hide only ever removes a message from the
 * hider's own thread. The history query binds the `message_hides` exclusion
 * to the READER's id, so another participant's read never matches the hider's
 * row.
 */
describe('MessagesService.getMessages hide scoping (PRD-227)', () => {
  interface HistoryQueryMock {
    where: jest.Mock;
    andWhere: jest.Mock;
    withDeleted: jest.Mock;
    addSelect: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getRawAndEntities: jest.Mock;
    getMany: jest.Mock;
  }

  function makeHistoryQuery(): HistoryQueryMock {
    const query = {} as HistoryQueryMock;
    const self = (): HistoryQueryMock => query;
    query.where = jest.fn(self);
    query.andWhere = jest.fn(self);
    query.withDeleted = jest.fn(self);
    query.addSelect = jest.fn(self);
    query.orderBy = jest.fn(self);
    query.addOrderBy = jest.fn(self);
    query.take = jest.fn(self);
    query.getRawAndEntities = jest
      .fn()
      .mockResolvedValue({ entities: [], raw: [] });
    query.getMany = jest.fn().mockResolvedValue([]);
    return query;
  }

  const HIDE_EXCLUSION = '"mh"."user_id" = :hidingUserId';

  let service: MessagesService;
  let historyQuery: HistoryQueryMock;
  let core: { requireParticipant: jest.Mock; toMessageResponses: jest.Mock };

  beforeEach(() => {
    historyQuery = makeHistoryQuery();
    core = {
      requireParticipant: jest.fn(
        async (conversationId: string, userId: string) => ({
          conversationId,
          userId,
          clearedAt: null,
          leftAt: null,
        }),
      ),
      toMessageResponses: jest.fn().mockResolvedValue([]),
    };
    const empty = {} as Record<string, never>;
    service = new MessagesService(
      // `getMessages` now looks up the conversation's `kind` (group vs DM) for
      // its own block-filter branching; this suite exercises hide-scoping
      // only, so a bare `null` conversation is fine here.
      {
        findOne: jest.fn().mockResolvedValue(null),
      } as unknown as Repository<Conversation>,
      empty as unknown as Repository<ConversationParticipant>,
      {
        createQueryBuilder: jest.fn(() => historyQuery),
      } as unknown as Repository<Message>,
      empty as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      empty as unknown as EventEmitter2,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
  });

  it("binds the backward history page's hide exclusion to the reader", async () => {
    await service.getMessages(CONVERSATION_ID, OTHER_PARTICIPANT_ID, {});

    expect(historyQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(HIDE_EXCLUSION),
      { hidingUserId: OTHER_PARTICIPANT_ID },
    );
    expect(historyQuery.andWhere).not.toHaveBeenCalledWith(expect.anything(), {
      hidingUserId: VIEWER_ID,
    });
  });

  it('binds the reconnect-sync forward page to the reader too, so a hidden message is never resurrected', async () => {
    await service.getMessages(CONVERSATION_ID, VIEWER_ID, {
      after: '2026-09-01T10:00:00.000Z',
    });

    expect(historyQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(HIDE_EXCLUSION),
      { hidingUserId: VIEWER_ID },
    );
  });
});
