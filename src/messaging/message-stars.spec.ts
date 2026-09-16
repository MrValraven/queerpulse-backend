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
import { MessagingCoreService } from './messaging-core.service';

const CONVERSATION_ID = 'c1';
const MESSAGE_ID = 'm1';
const VIEWER_ID = 'viewer';

/**
 * Chainable stand-in for the `INSERT ... ON CONFLICT DO NOTHING` builder the
 * star write runs. Every builder method returns the same object; `execute` is
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

describe('MessageAnnotationsService stars (private per-user bookmarks)', () => {
  let service: MessageAnnotationsService;
  let messages: { findOne: jest.Mock };
  let stars: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let core: {
    requireParticipant: jest.Mock;
    requireActiveParticipant: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let insertQuery: InsertQueryMock;

  const activeParticipant = {
    conversationId: CONVERSATION_ID,
    userId: VIEWER_ID,
    clearedAt: null,
    leftAt: null,
  };

  beforeEach(() => {
    insertQuery = makeInsertQuery();
    messages = {
      findOne: jest.fn().mockResolvedValue({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: 'other',
        deletedAt: null,
      }),
    };
    stars = {
      createQueryBuilder: jest.fn(() => insertQuery),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    };
    core = {
      requireParticipant: jest.fn().mockResolvedValue(activeParticipant),
      requireActiveParticipant: jest.fn().mockResolvedValue(activeParticipant),
    };
    eventEmitter = { emit: jest.fn() };
    service = new MessageAnnotationsService(
      {} as Repository<Conversation>,
      {} as Repository<ConversationParticipant>,
      messages as unknown as Repository<Message>,
      {} as Repository<MessageReaction>,
      {} as Repository<ConversationPinnedMessage>,
      stars as unknown as Repository<MessageStar>,
      {} as Repository<MessageHide>,
      {} as Repository<Profile>,
      core as unknown as MessagingCoreService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('starMessage', () => {
    it("stars the message under the caller's own id, idempotently, and emits nothing", async () => {
      await expect(
        service.starMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
      ).resolves.toEqual({ ok: true });

      expect(core.requireActiveParticipant).toHaveBeenCalledWith(
        CONVERSATION_ID,
        VIEWER_ID,
      );
      expect(insertQuery.into).toHaveBeenCalledWith(MessageStar);
      expect(insertQuery.values).toHaveBeenCalledWith({
        userId: VIEWER_ID,
        messageId: MESSAGE_ID,
      });
      // ON CONFLICT DO NOTHING: a repeat star is a no-op success.
      expect(insertQuery.orIgnore).toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a member who left, or a blocked DM counterpart, before touching the message', async () => {
      core.requireActiveParticipant.mockRejectedValue(
        new ForbiddenException('You have left this conversation'),
      );

      await expect(
        service.starMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(messages.findOne).not.toHaveBeenCalled();
      expect(stars.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('scopes the message lookup to this conversation without tombstones, and 404s a miss', async () => {
      // The default `findOne` (no `withDeleted`) skips a soft-deleted row, and
      // the conversation id in the filter refuses a message from another thread.
      messages.findOne.mockResolvedValue(null);

      await expect(
        service.starMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(messages.findOne).toHaveBeenCalledWith({
        where: { id: MESSAGE_ID, conversationId: CONVERSATION_ID },
      });
      expect(stars.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('unstarMessage', () => {
    it("deletes only the caller's own star row and emits nothing", async () => {
      await expect(
        service.unstarMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
      ).resolves.toEqual({ ok: true });

      expect(stars.delete).toHaveBeenCalledWith({
        userId: VIEWER_ID,
        messageId: MESSAGE_ID,
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('stays open to a member who has left, on the lenient participant check', async () => {
      core.requireParticipant.mockResolvedValue({
        ...activeParticipant,
        leftAt: new Date('2026-09-01T10:00:00.000Z'),
      });

      await expect(
        service.unstarMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
      ).resolves.toEqual({ ok: true });
      expect(core.requireParticipant).toHaveBeenCalledWith(
        CONVERSATION_ID,
        VIEWER_ID,
      );
      expect(core.requireActiveParticipant).not.toHaveBeenCalled();
      expect(stars.delete).toHaveBeenCalledWith({
        userId: VIEWER_ID,
        messageId: MESSAGE_ID,
      });
    });

    it('refuses a non-participant before deleting anything', async () => {
      core.requireParticipant.mockRejectedValue(
        new ForbiddenException('You are not a participant'),
      );

      await expect(
        service.unstarMessage(CONVERSATION_ID, MESSAGE_ID, 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(stars.delete).not.toHaveBeenCalled();
    });
  });
});
