import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { encodeCursor } from '../common/cursor-pagination';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { MessageCreatedEvent } from './messaging.events';
import { MessagingService } from './messaging.service';

/**
 * Minimal chainable stand-in for a TypeORM SelectQueryBuilder. Every builder
 * method returns the same object so the fluent chain works; `getMany` /
 * `getRawMany` are the terminal awaited calls the tests configure.
 */
interface MockQb {
  distinctOn: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  groupBy: jest.Mock;
  take: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
}

function makeQb(): MockQb {
  const qb = {} as MockQb;
  const self = (): MockQb => qb;
  qb.distinctOn = jest.fn(self);
  qb.select = jest.fn(self);
  qb.addSelect = jest.fn(self);
  qb.innerJoin = jest.fn(self);
  qb.where = jest.fn(self);
  qb.andWhere = jest.fn(self);
  qb.orderBy = jest.fn(self);
  qb.addOrderBy = jest.fn(self);
  qb.groupBy = jest.fn(self);
  qb.take = jest.fn(self);
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
}

describe('MessagingService', () => {
  let service: MessagingService;
  let conversations: { findOne: jest.Mock; find: jest.Mock; create: jest.Mock };
  let participants: {
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
  };
  let messages: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let connections: { areConnected: jest.Mock; requestConnection: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    conversations = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v) => v),
    };
    participants = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(async (v) => v),
      exists: jest.fn().mockResolvedValue(true),
    };
    messages = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({
        id: 'm1',
        createdAt: new Date(),
        editedAt: null,
        ...v,
      })),
      createQueryBuilder: jest.fn(() => makeQb()),
    };
    profiles = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    dataSource = { transaction: jest.fn() };
    connections = {
      areConnected: jest.fn().mockResolvedValue(true),
      requestConnection: jest.fn(),
    };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: participants,
        },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ConnectionsService, useValue: connections },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  describe('listConversations', () => {
    it('returns [] when the user has no participant rows', async () => {
      participants.find.mockResolvedValueOnce([]);
      await expect(service.listConversations('me')).resolves.toEqual([]);
      // Short-circuits before touching messages.
      expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('maps grouped unread counts, sorts newest-first, and 0s conversations with no unread row', async () => {
      participants.find
        // myParts
        .mockResolvedValueOnce([
          { conversationId: 'c1', muted: false, lastReadAt: null },
          { conversationId: 'c2', muted: true, lastReadAt: new Date() },
        ])
        // others (non-self)
        .mockResolvedValueOnce([
          { conversationId: 'c1', userId: 'u2' },
          { conversationId: 'c2', userId: 'u3' },
        ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'c2',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'u2',
          slug: 'alice',
          firstName: 'Alice',
          lastName: 'A',
          avatarUrl: null,
        },
        {
          userId: 'u3',
          slug: 'bob',
          firstName: 'Bob',
          lastName: 'B',
          avatarUrl: null,
        },
      ]);

      const lastQb = makeQb();
      // c1 is newer than c2 → must sort first.
      lastQb.getMany.mockResolvedValue([
        {
          conversationId: 'c1',
          id: 'm-c1',
          senderId: 'u2',
          body: 'hi',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          conversationId: 'c2',
          id: 'm-c2',
          senderId: 'u3',
          body: 'yo',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      const unreadQb = makeQb();
      unreadQb.getRawMany.mockResolvedValue([
        { conversationId: 'c1', count: '2' },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(lastQb)
        .mockReturnValueOnce(unreadQb);

      const result = await service.listConversations('me');

      expect(result.map((c) => c.id)).toEqual(['c1', 'c2']); // newest-first
      expect(result[0].unreadCount).toBe(2);
      expect(result[1].unreadCount).toBe(0); // absent from unread rows
      // Contract shape: `otherParticipant` with handle/displayName, not the
      // internal slug/firstName/lastName.
      expect(result[0].otherParticipant).toEqual({
        handle: 'alice',
        displayName: 'Alice A',
        avatarUrl: null,
      });
      expect(result[0].type).toBe('dm');
      // `updatedAt` tracks last activity (the newest message).
      expect(result[0].updatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(result[1].updatedAt).toBe('2026-01-01T00:00:00.000Z');
      // No N+1: exactly two message queries regardless of conversation count.
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('emits a `sender` on every lastMessage — including one the caller sent', async () => {
      participants.find
        .mockResolvedValueOnce([
          { conversationId: 'c1', muted: false, lastReadAt: null },
        ])
        .mockResolvedValueOnce([{ conversationId: 'c1', userId: 'u2' }]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      // The caller's own profile must be loaded too: they may be the sender of
      // the last message, and `MessageResponse.sender` is non-nullable.
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'u2',
          slug: 'alice',
          firstName: 'Alice',
          lastName: 'A',
          avatarUrl: null,
        },
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'Myself',
          avatarUrl: 'https://cdn.example/me.png',
        },
      ]);

      const lastQb = makeQb();
      lastQb.getMany.mockResolvedValue([
        {
          conversationId: 'c1',
          id: 'm-c1',
          senderId: 'me', // the caller sent the newest message
          body: 'hi',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(lastQb)
        .mockReturnValueOnce(makeQb());

      const result = await service.listConversations('me');

      expect(result[0].lastMessage?.sender).toEqual({
        handle: 'me-handle',
        displayName: 'Me Myself',
        avatarUrl: 'https://cdn.example/me.png',
      });
      expect(result[0].lastMessage?.conversationId).toBe('c1');
      expect(result[0].lastMessage?.createdAt).toBe('2026-01-02T00:00:00.000Z');
      // The caller is queried alongside the counterparts, in the same query.
      const findCalls = profiles.find.mock.calls as [
        { where: { userId: FindOperator<string> } },
      ][];
      expect(findCalls[0][0].where.userId.value).toEqual(
        expect.arrayContaining(['u2', 'me']),
      );
    });

    it('expresses the null-lastReadAt branch in the unread query', async () => {
      participants.find
        .mockResolvedValueOnce([
          { conversationId: 'c1', muted: false, lastReadAt: null },
        ])
        .mockResolvedValueOnce([]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      const lastQb = makeQb();
      const unreadQb = makeQb();
      messages.createQueryBuilder
        .mockReturnValueOnce(lastQb)
        .mockReturnValueOnce(unreadQb);

      await service.listConversations('me');

      const clauses = unreadQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).toContain(
        '(p.last_read_at IS NULL OR m.created_at > p.last_read_at)',
      );
    });

    it('renders official/welcome threads as type "group" with no otherParticipant (>2 participants)', async () => {
      participants.find
        .mockResolvedValueOnce([
          { conversationId: 'off', muted: false, lastReadAt: null },
        ])
        // two other participants on the official thread
        .mockResolvedValueOnce([
          { conversationId: 'off', userId: 'x' },
          { conversationId: 'off', userId: 'y' },
        ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'off',
          isOfficial: true,
          createdAt: new Date('2026-03-04T05:06:07Z'),
        },
      ]);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'x',
          slug: 'x',
          firstName: 'X',
          lastName: 'X',
          avatarUrl: null,
        },
        {
          userId: 'y',
          slug: 'y',
          firstName: 'Y',
          lastName: 'Y',
          avatarUrl: null,
        },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb())
        .mockReturnValueOnce(makeQb());

      const result = await service.listConversations('me');

      expect(result[0].isOfficial).toBe(true);
      expect(result[0].type).toBe('group');
      expect(result[0].otherParticipant).toBeNull();
      expect(result[0].lastMessage).toBeNull();
      // No messages yet, so last activity falls back to the thread's creation
      // (`conversations` has no updated_at column).
      expect(result[0].updatedAt).toBe('2026-03-04T05:06:07.000Z');
    });
  });

  describe('getMessages', () => {
    beforeEach(() => {
      // requireParticipant passes.
      participants.findOne.mockResolvedValue({
        conversationId: 'c1',
        userId: 'me',
      });
    });

    it('clamps the limit to MAX_LIMIT and defaults when unset', async () => {
      const qbBig = makeQb();
      const qbDefault = makeQb();
      messages.createQueryBuilder
        .mockReturnValueOnce(qbBig)
        .mockReturnValueOnce(qbDefault);

      await service.getMessages('c1', 'me', { limit: 500 });
      expect(qbBig.take).toHaveBeenCalledWith(100);

      await service.getMessages('c1', 'me', {});
      expect(qbDefault.take).toHaveBeenCalledWith(30);
    });

    it('uses a plain created_at cursor when only `before` is given', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMessages('c1', 'me', { before: '2026-01-01T00:00:00Z' });
      expect(qb.andWhere).toHaveBeenCalledWith('m.created_at < :before', {
        before: '2026-01-01T00:00:00Z',
      });
    });

    it('uses a composite (created_at, id) cursor when `beforeId` is also given', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMessages('c1', 'me', {
        before: '2026-01-01T00:00:00Z',
        beforeId: '11111111-1111-4111-8111-111111111111',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        expect.objectContaining({
          beforeId: '11111111-1111-4111-8111-111111111111',
        }),
      );
    });

    it('orders created_at DESC, id DESC and reads through the QueryBuilder (soft-delete excluded)', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMessages('c1', 'me', {});
      expect(qb.orderBy).toHaveBeenCalledWith('m.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('m.id', 'DESC');
      // Going through createQueryBuilder is what applies the @DeleteDateColumn
      // soft-delete filter (raw SQL would not).
      expect(messages.createQueryBuilder).toHaveBeenCalledWith('m');
    });

    it('rejects a non-participant', async () => {
      participants.findOne.mockReset();
      participants.findOne.mockResolvedValue(null);
      await expect(
        service.getMessages('c1', 'intruder', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('decodes an opaque `cursor` into the same composite keyset predicate', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      const cursor = encodeCursor({
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        id: '11111111-1111-4111-8111-111111111111',
      });

      await service.getMessages('c1', 'me', { cursor });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        {
          before: '2026-01-01T00:00:00.000Z',
          beforeId: '11111111-1111-4111-8111-111111111111',
        },
      );
    });

    it('treats a malformed `cursor` as no cursor (first page)', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getMessages('c1', 'me', { cursor: 'not-a-real-cursor' });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('prefers an explicit `before`/`beforeId` over `cursor` when both are given', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      const cursor = encodeCursor({
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        id: '22222222-2222-4222-8222-222222222222',
      });

      await service.getMessages('c1', 'me', {
        before: '2026-01-01T00:00:00Z',
        cursor,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('m.created_at < :before', {
        before: '2026-01-01T00:00:00Z',
      });
    });

    it('returns MessageResponses with a resolved `sender` on every message', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([
        {
          id: 'm2',
          conversationId: 'c1',
          senderId: 'them',
          body: 'yo',
          createdAt: new Date('2026-01-02T00:00:00Z'),
          editedAt: null,
        },
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'me',
          body: 'hi',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          editedAt: null,
        },
      ]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'them',
          slug: 'tam-rivera',
          firstName: 'Tam',
          lastName: 'Rivera',
          avatarUrl: null,
        },
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'Myself',
          avatarUrl: null,
        },
      ]);

      const result = await service.getMessages('c1', 'me', {});

      expect(result).toEqual([
        {
          id: 'm2',
          conversationId: 'c1',
          body: 'yo',
          sender: {
            handle: 'tam-rivera',
            displayName: 'Tam Rivera',
            avatarUrl: null,
          },
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'm1',
          conversationId: 'c1',
          body: 'hi',
          sender: {
            handle: 'me-handle',
            displayName: 'Me Myself',
            avatarUrl: null,
          },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      // The internal `senderId` is gone: the frontend reads `sender` only.
      expect(result[0]).not.toHaveProperty('senderId');
      // Senders are hydrated in ONE query for the whole page, not per message.
      expect(profiles.find).toHaveBeenCalledTimes(1);
    });

    it('falls back to a placeholder sender rather than emitting a message with none', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'ghost', // profile can't be resolved
          body: 'hi',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          editedAt: null,
        },
      ]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      profiles.find.mockResolvedValueOnce([]);

      const result = await service.getMessages('c1', 'me', {});

      // Never null/undefined — the frontend adapter reads sender.displayName
      // unguarded and would throw a TypeError.
      expect(result[0].sender).toEqual({
        handle: '',
        displayName: 'Member',
        avatarUrl: null,
      });
    });

    it('skips the profile query entirely for an empty page', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      await expect(service.getMessages('c1', 'me', {})).resolves.toEqual([]);
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('stamps lastReadAt with the DB clock (now()) and emits with the DB value', async () => {
      const dbTime = new Date('2026-06-30T12:00:00Z');
      participants.findOne
        // requireParticipant
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        // re-read after the DB-side update
        .mockResolvedValueOnce({
          conversationId: 'c1',
          userId: 'me',
          lastReadAt: dbTime,
        });

      const result = await service.markRead('c1', 'me');

      expect(result).toEqual({ ok: true });
      const where = participants.update.mock.calls[0][0] as Record<
        string,
        string
      >;
      const values = participants.update.mock.calls[0][1] as {
        lastReadAt: () => string;
      };
      expect(where).toEqual({ conversationId: 'c1', userId: 'me' });
      // Value is a raw-SQL function so Postgres, not the app server, sets the time.
      expect(typeof values.lastReadAt).toBe('function');
      expect(values.lastReadAt()).toBe('now()');
      // Does NOT save the participant entity with an app-server Date.
      expect(participants.save).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith(
        'message.read',
        expect.objectContaining({ lastReadAt: dbTime }),
      );
    });

    it('rejects a non-participant before touching the DB', async () => {
      participants.findOne.mockResolvedValueOnce(null);
      await expect(service.markRead('c1', 'ghost')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(participants.update).not.toHaveBeenCalled();
    });
  });

  describe('setMuted', () => {
    it('saves the participant with the new muted flag', async () => {
      participants.findOne.mockResolvedValueOnce({
        conversationId: 'c1',
        userId: 'me',
        muted: false,
      });
      const result = await service.setMuted('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(participants.save).toHaveBeenCalledWith(
        expect.objectContaining({ muted: true }),
      );
    });
  });

  describe('sendMessage', () => {
    it('rejects a non-participant', async () => {
      participants.findOne.mockResolvedValueOnce(null);
      await expect(
        service.sendMessage('c1', 'intruder', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when the participants are no longer connected', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(false);
      await expect(
        service.sendMessage('c1', 'me', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists and emits message.created on a valid send', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);

      const result = await service.sendMessage('c1', 'me', 'hello');
      expect(result.body).toBe('hello');
      expect(emitter.emit).toHaveBeenCalledWith(
        'message.created',
        expect.objectContaining({ conversationId: 'c1' }),
      );
    });

    it('returns a MessageResponse carrying the sender, not the internal view', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);
      messages.save.mockResolvedValueOnce({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        body: 'hello',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        editedAt: null,
      });
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'Myself',
          avatarUrl: null,
        },
      ]);

      const result = await service.sendMessage('c1', 'me', 'hello');

      expect(result).toEqual({
        id: 'm1',
        conversationId: 'c1',
        body: 'hello',
        sender: {
          handle: 'me-handle',
          displayName: 'Me Myself',
          avatarUrl: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(result).not.toHaveProperty('senderId');
    });

    it('still emits the internal MessageView (with senderId) on message.created', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);

      await service.sendMessage('c1', 'me', 'hello');

      // The event payload is internal (chat.gateway consumers), and is
      // deliberately NOT remapped to the frontend contract here.
      const emitCalls = emitter.emit.mock.calls as [
        string,
        MessageCreatedEvent,
      ][];
      const [eventName, payload] = emitCalls[0];
      expect(eventName).toBe('message.created');
      expect(payload.conversationId).toBe('c1');
      expect(payload.message.senderId).toBe('me');
      expect(payload.message.body).toBe('hello');
    });
  });

  describe('messageRequest', () => {
    it('rejects when either party has blocked the other', async () => {
      profiles.findOne.mockResolvedValueOnce({ userId: 'them', slug: 'them' });
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(
        service.messageRequest('me', 'them', 'hi there'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
      expect(connections.areConnected).not.toHaveBeenCalled();
      expect(connections.requestConnection).not.toHaveBeenCalled();
    });

    it('when already connected: materializes a conversation and posts the message', async () => {
      profiles.findOne.mockResolvedValueOnce({ userId: 'them', slug: 'them' });
      connections.areConnected.mockResolvedValue(true);
      // getOrCreateConversation finds an existing thread (no transaction).
      conversations.findOne.mockResolvedValueOnce({
        id: 'c9',
        isOfficial: false,
      });

      const result = await service.messageRequest('me', 'them', 'hey');

      expect(result.conversationId).toBe('c9');
      expect(result.message?.body).toBe('hey');
      expect(result.connectionRequestId).toBeNull();
      expect(connections.requestConnection).not.toHaveBeenCalled();
    });

    it('when a stranger: seeds a connection request instead of a message', async () => {
      profiles.findOne.mockResolvedValueOnce({ userId: 'them', slug: 'them' });
      connections.areConnected.mockResolvedValue(false);
      connections.requestConnection.mockResolvedValue({ id: 'conn-1' });

      const result = await service.messageRequest('me', 'them', 'hi there');

      expect(result.conversationId).toBeNull();
      expect(result.message).toBeNull();
      expect(result.connectionRequestId).toBe('conn-1');
      expect(connections.requestConnection).toHaveBeenCalledWith(
        'me',
        'them',
        'hi there',
      );
    });
  });

  describe('createConversation', () => {
    const recipient = {
      userId: 'them',
      slug: 'tam-rivera',
      firstName: 'Tam',
      lastName: 'Rivera',
      avatarUrl: null,
    };

    it('creates a new DM when none exists and returns a ConversationResponse', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      // getOrCreateConversation: no existing pairKey row -> materializes one.
      conversations.findOne.mockResolvedValueOnce(null);
      const created = {
        id: 'convo-1',
        isOfficial: false,
        pairKey: 'me:them',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      dataSource.transaction.mockResolvedValueOnce(created);
      // toConversationResponse: profile lookup for both participants, plus
      // the last-message/unread-count query-builder queries (no rows yet).
      profiles.find.mockResolvedValueOnce([recipient]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb()) // lastMessagesByConversation
        .mockReturnValueOnce(makeQb()); // unreadCountsByConversation

      const result = await service.createConversation('me', 'tam-rivera');

      expect(result.id).toBe('convo-1');
      expect(result.type).toBe('dm');
      expect(result.otherParticipant).toEqual({
        handle: 'tam-rivera',
        displayName: 'Tam Rivera',
        avatarUrl: null,
      });
      expect(result.lastMessage).toBeNull();
      expect(result.unreadCount).toBe(0);
    });

    it('is idempotent: calling twice returns the same conversation id, only creating once', async () => {
      profiles.findOne.mockResolvedValue(recipient);
      profiles.find.mockResolvedValue([recipient]);
      messages.createQueryBuilder.mockImplementation(() => makeQb());

      // First call: no existing conversation, materializes one.
      conversations.findOne.mockResolvedValueOnce(null);
      const created = {
        id: 'convo-1',
        isOfficial: false,
        pairKey: 'me:them',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      dataSource.transaction.mockResolvedValueOnce(created);
      const first = await service.createConversation('me', 'tam-rivera');

      // Second call: the same pairKey row now exists -> reused, no transaction.
      conversations.findOne.mockResolvedValueOnce(created);
      const second = await service.createConversation('me', 'tam-rivera');

      expect(first.id).toBe('convo-1');
      expect(second.id).toBe('convo-1');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('404s when recipientHandle does not resolve to a member', async () => {
      profiles.findOne.mockResolvedValueOnce(null);
      await expect(
        service.createConversation('me', 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400s when recipientHandle resolves to the caller themself', async () => {
      profiles.findOne.mockResolvedValueOnce({ ...recipient, userId: 'me' });
      await expect(
        service.createConversation('me', 'my-own-slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when either party has blocked the other', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(
        service.createConversation('me', 'tam-rivera'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateConversation (via CONNECTION_ACCEPTED)', () => {
    it('recovers from a concurrent create race (23505) by returning the winner', async () => {
      // First lookup misses → we attempt to create.
      conversations.findOne
        .mockResolvedValueOnce(null)
        // After the unique-violation, the winner is fetched.
        .mockResolvedValueOnce({ id: 'winner', isOfficial: false });
      const unique = new QueryFailedError('INSERT', [], {
        code: '23505',
      } as never);
      dataSource.transaction.mockRejectedValueOnce(unique);

      await expect(
        service.handleConnectionAccepted({
          connectionId: 'x',
          requesterId: 'a',
          addresseeId: 'b',
          requestMessage: null,
        }),
      ).resolves.toBeUndefined();

      // No seed message posted (created === false on the recovered winner).
      expect(messages.save).not.toHaveBeenCalled();
    });

    it('re-throws a non-unique-violation error', async () => {
      conversations.findOne.mockResolvedValueOnce(null);
      dataSource.transaction.mockRejectedValueOnce(new Error('boom'));
      await expect(
        service.handleConnectionAccepted({
          connectionId: 'x',
          requesterId: 'a',
          addresseeId: 'b',
          requestMessage: null,
        }),
      ).rejects.toThrow('boom');
    });
  });
});
