import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import { MessagingCoreService } from './messaging-core.service';
import { MESSAGE_DELIVERED } from './messaging.events';

const CONVERSATION_ID = 'c1';
const VIEWER_ID = 'viewer';

/** Collapses the whitespace of a multi-line SQL fragment for substring checks. */
function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

/**
 * Chainable stand-in for the single aggregate QueryBuilder
 * `unreadConversationCount` runs. Every builder method returns the same
 * object; `getRawOne` is the terminal awaited call.
 */
interface UnreadCountQueryMock {
  select: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  getRawOne: jest.Mock;
}

function makeUnreadCountQuery(): UnreadCountQueryMock {
  const query = {} as UnreadCountQueryMock;
  const self = (): UnreadCountQueryMock => query;
  query.select = jest.fn(self);
  query.innerJoin = jest.fn(self);
  query.where = jest.fn(self);
  query.andWhere = jest.fn(self);
  query.setParameter = jest.fn(self);
  query.getRawOne = jest.fn().mockResolvedValue({ count: '0' });
  return query;
}

describe('MessagingCoreService.unreadConversationCount (nav DM badge, PRD-341)', () => {
  let core: MessagingCoreService;
  let participants: { createQueryBuilder: jest.Mock };
  let query: UnreadCountQueryMock;

  /** Every `andWhere` SQL fragment, whitespace collapsed. */
  function andWhereFragments(): string[] {
    return query.andWhere.mock.calls.map((call: unknown[]) =>
      normaliseSql(String(call[0])),
    );
  }

  /** The one fragment that decides whether a thread counts as unread. */
  function unreadFragment(): string {
    const fragment = andWhereFragments().find((sql) =>
      sql.includes('marked_unread_at'),
    );
    if (!fragment) {
      throw new Error('unread predicate was not applied');
    }
    return fragment;
  }

  beforeEach(() => {
    query = makeUnreadCountQuery();
    participants = { createQueryBuilder: jest.fn(() => query) };
    const empty = {} as Record<string, never>;
    core = new MessagingCoreService(
      empty as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      empty as unknown as Repository<Message>,
      empty as unknown as Repository<MessageReaction>,
      empty as unknown as Repository<ConversationPinnedMessage>,
      empty as unknown as Repository<MessageStar>,
      empty as unknown as Repository<MessageHide>,
      empty as unknown as Repository<ContentModeration>,
      empty as unknown as Repository<Profile>,
      empty as unknown as DataSource,
      empty as unknown as EventEmitter2,
      empty as unknown as UsersService,
    );
  });

  it("counts distinct conversations from the caller's own participant rows", async () => {
    query.getRawOne.mockResolvedValue({ count: '3' });

    await expect(core.unreadConversationCount(VIEWER_ID)).resolves.toBe(3);

    expect(participants.createQueryBuilder).toHaveBeenCalledWith('p');
    expect(query.select).toHaveBeenCalledWith(
      'COUNT(DISTINCT p.conversation_id)',
      'count',
    );
    expect(query.where).toHaveBeenCalledWith('p.user_id = :userId', {
      userId: VIEWER_ID,
    });
  });

  it('reads a missing aggregate row as zero', async () => {
    query.getRawOne.mockResolvedValue(undefined);

    await expect(core.unreadConversationCount(VIEWER_ID)).resolves.toBe(0);
  });

  it('never counts an archived conversation', async () => {
    await core.unreadConversationCount(VIEWER_ID);

    expect(andWhereFragments()).toContain('p.archived_at IS NULL');
  });

  it("counts a manual mark-unread, or a message from someone else past the caller's read watermark", async () => {
    await core.unreadConversationCount(VIEWER_ID);

    const fragment = unreadFragment();
    expect(fragment).toContain('p.marked_unread_at IS NOT NULL OR EXISTS');
    expect(fragment).toContain('m.conversation_id = p.conversation_id');
    // The caller's own messages never make a thread unread for them.
    expect(fragment).toContain('m.sender_id != :userId');
    expect(fragment).toContain(
      '(p.last_read_at IS NULL OR m.created_at > p.last_read_at)',
    );
  });

  it('floors at the clear point and ceilings at the moment a member left', async () => {
    await core.unreadConversationCount(VIEWER_ID);

    const fragment = unreadFragment();
    expect(fragment).toContain(
      '(p.cleared_at IS NULL OR m.created_at > p.cleared_at)',
    );
    expect(fragment).toContain(
      '(p.left_at IS NULL OR m.created_at <= p.left_at)',
    );
  });

  it('never counts a moderator takedown or a message the caller hid, with the hide bound to the caller', async () => {
    await core.unreadConversationCount(VIEWER_ID);

    const fragment = unreadFragment();
    expect(fragment).toContain(
      '("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)',
    );
    expect(fragment).toContain(
      '"mh"."message_id" = m.id AND "mh"."user_id" = :hiddenForUserId',
    );
    expect(query.setParameter).toHaveBeenCalledWith(
      'hiddenForUserId',
      VIEWER_ID,
    );
    expect(query.setParameter).toHaveBeenCalledWith(
      'messageSubjectType',
      'message',
    );
  });

  it('drops a direct thread blocked in either direction, and never a group or the official thread', async () => {
    await core.unreadConversationCount(VIEWER_ID);

    const blockCall = query.andWhere.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('"blocks"'),
    ) as [string, Record<string, unknown>] | undefined;
    expect(blockCall).toBeDefined();
    const [blockSql, blockParameters] = blockCall as [
      string,
      Record<string, unknown>,
    ];
    const fragment = normaliseSql(blockSql);
    expect(fragment).toContain('NOT EXISTS');
    expect(fragment).toContain(
      '("__unread_block"."blocker_id" = :userId AND "__unread_block"."blocked_id" = "__unread_other"."user_id")',
    );
    expect(fragment).toContain(
      '("__unread_block"."blocked_id" = :userId AND "__unread_block"."blocker_id" = "__unread_other"."user_id")',
    );
    expect(fragment).toContain('c."kind" != :unreadGroupKind');
    expect(fragment).toContain('c."is_official" = false');
    expect(blockParameters).toEqual({
      unreadGroupKind: ConversationKind.Group,
    });
  });

  // The unread EXISTS subquery is raw SQL over `"messages" m`, and the
  // @DeleteDateColumn default filter only applies to a QueryBuilder's own
  // entity alias, so the soft-delete check has to be spelled out inside the
  // subquery. Without it a message deleted for everyone kept the badge lit
  // while `unreadCountsByConversation` (a real `createQueryBuilder('m')`)
  // showed that thread's row at zero unread.
  it('never counts a message deleted for everyone (a soft-deleted tombstone) toward the badge', async () => {
    await core.unreadConversationCount(VIEWER_ID);

    const fragment = unreadFragment();
    const existsStart = fragment.indexOf('EXISTS (');
    expect(existsStart).toBeGreaterThan(-1);
    const messageSubquery = fragment.slice(existsStart);
    expect(messageSubquery).toContain('SELECT 1 FROM "messages" m');
    expect(messageSubquery).toContain('AND m.deleted_at IS NULL');
    // The takedown and self-hide exclusions sit in the same per-message
    // subquery, with both of their placeholders bound on the outer builder.
    expect(messageSubquery).toContain(
      '"cm"."subject_type" = :messageSubjectType',
    );
    expect(messageSubquery).toContain('"mh"."user_id" = :hiddenForUserId');
    expect(query.setParameter).toHaveBeenCalledWith(
      'messageSubjectType',
      'message',
    );
    expect(query.setParameter).toHaveBeenCalledWith(
      'hiddenForUserId',
      VIEWER_ID,
    );
  });
});

describe('ConversationsService.markDelivered (delivered watermark)', () => {
  const STORED_DELIVERED_AT = new Date('2026-09-15T09:30:00.000Z');

  let service: ConversationsService;
  let participants: { update: jest.Mock; findOne: jest.Mock };
  let core: { requireActiveParticipant: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(() => {
    participants = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        deliveredAt: STORED_DELIVERED_AT,
      }),
    };
    core = {
      requireActiveParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        leftAt: null,
      }),
    };
    eventEmitter = { emit: jest.fn() };
    const empty = {} as Record<string, never>;
    service = new ConversationsService(
      empty as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      empty as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      empty as never,
      eventEmitter as unknown as EventEmitter2,
      empty as unknown as DataSource,
      empty as never,
      empty as never,
      // PRD-364: `PreferencesService`, unused by `markDelivered` (this describe
      // block's only path under test).
      empty as never,
    );
  });

  it("stamps only the caller's own participant row, with the database clock and nothing else", async () => {
    await expect(
      service.markDelivered(CONVERSATION_ID, VIEWER_ID),
    ).resolves.toEqual({ ok: true });

    expect(participants.update).toHaveBeenCalledTimes(1);
    const [criteria, changes] = participants.update.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).toEqual({
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
    });
    // The watermark is always the database's own `now()`, so neither the
    // client nor the app server chooses the value.
    expect(Object.keys(changes)).toEqual(['deliveredAt']);
    const deliveredAtExpression = changes.deliveredAt as () => string;
    expect(typeof deliveredAtExpression).toBe('function');
    expect(deliveredAtExpression()).toBe('now()');
  });

  it('relays the watermark read back from the row, so every device sees the stored value', async () => {
    await service.markDelivered(CONVERSATION_ID, VIEWER_ID);

    expect(participants.findOne).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID, userId: VIEWER_ID },
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(MESSAGE_DELIVERED, {
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      deliveredAt: STORED_DELIVERED_AT,
    });
  });

  it('refuses a member who left, or a blocked counterpart, before writing or broadcasting', async () => {
    core.requireActiveParticipant.mockRejectedValue(
      new ForbiddenException('You have left this conversation'),
    );

    await expect(
      service.markDelivered(CONVERSATION_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(core.requireActiveParticipant).toHaveBeenCalledWith(
      CONVERSATION_ID,
      VIEWER_ID,
    );
    expect(participants.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
