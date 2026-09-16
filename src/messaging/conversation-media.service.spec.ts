import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  ConversationMediaService,
  LINK_BODY_PATTERN,
} from './conversation-media.service';
import { ConversationMediaKind } from './dto/list-conversation-media.query';
import { Message, MessageKind } from './entities/message.entity';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
} from './message-history-cursor';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Chainable stand-in for the one gallery QueryBuilder. Every builder method
 * returns the same object; `getRawAndEntities` is the terminal awaited call
 * each test configures.
 */
interface GalleryQueryMock {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  withDeleted: jest.Mock;
  getRawAndEntities: jest.Mock;
}

function makeGalleryQuery(): GalleryQueryMock {
  const query = {} as GalleryQueryMock;
  const self = (): GalleryQueryMock => query;
  query.select = jest.fn(self);
  query.addSelect = jest.fn(self);
  query.where = jest.fn(self);
  query.andWhere = jest.fn(self);
  query.orderBy = jest.fn(self);
  query.addOrderBy = jest.fn(self);
  query.take = jest.fn(self);
  query.withDeleted = jest.fn(self);
  query.getRawAndEntities = jest
    .fn()
    .mockResolvedValue({ entities: [], raw: [] });
  return query;
}

describe('ConversationMediaService.listConversationMedia (PRD-373)', () => {
  const CONVERSATION_ID = 'c1';
  const VIEWER_ID = 'viewer';

  let service: ConversationMediaService;
  let galleryQuery: GalleryQueryMock;
  let messages: { createQueryBuilder: jest.Mock };
  let core: { requireParticipant: jest.Mock; toMessageResponses: jest.Mock };

  function makeMessageRow(id: string, createdAt: string, kind: MessageKind) {
    return {
      id,
      conversationId: CONVERSATION_ID,
      senderId: 'other',
      body: '',
      replyToId: null,
      createdAt: new Date(createdAt),
      editedAt: null,
      deletedAt: null,
      clientMessageId: null,
      forwarded: false,
      kind,
      systemEvent: null,
      attachment: null,
    };
  }

  /** Every `andWhere` SQL fragment the service composed, in order. */
  function andWhereClauses(): string[] {
    return galleryQuery.andWhere.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
  }

  function andWhereCallContaining(fragment: string): unknown[] | undefined {
    const calls = galleryQuery.andWhere.mock.calls as unknown[][];
    return calls.find((call) => (call[0] as string).includes(fragment));
  }

  beforeEach(() => {
    galleryQuery = makeGalleryQuery();
    messages = { createQueryBuilder: jest.fn(() => galleryQuery) };
    core = {
      requireParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        clearedAt: null,
        leftAt: null,
      }),
      toMessageResponses: jest.fn((rows: { id: string }[]) =>
        Promise.resolve(rows.map((row) => ({ id: row.id }))),
      ),
    };
    service = new ConversationMediaService(
      messages as unknown as Repository<Message>,
      core as unknown as MessagingCoreService,
    );
  });

  it('refuses a non-participant with the same 403 history returns, before any query', async () => {
    core.requireParticipant.mockRejectedValue(
      new ForbiddenException('You are not a participant'),
    );

    await expect(
      service.listConversationMedia(CONVERSATION_ID, 'stranger', {
        kind: ConversationMediaKind.Media,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(core.requireParticipant).toHaveBeenCalledWith(
      CONVERSATION_ID,
      'stranger',
    );
    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('scopes the query to this one conversation', async () => {
    await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
      kind: ConversationMediaKind.Media,
    });

    expect(galleryQuery.where).toHaveBeenCalledWith('m.conversation_id = :id', {
      id: CONVERSATION_ID,
    });
  });

  it('ceilings a member who left the group at their leftAt', async () => {
    const leftAt = new Date('2026-09-01T12:00:00.000Z');
    core.requireParticipant.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      clearedAt: null,
      leftAt,
    });

    await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
      kind: ConversationMediaKind.Documents,
    });

    expect(galleryQuery.andWhere).toHaveBeenCalledWith(
      'm.created_at <= :leftAt',
      { leftAt: leftAt.toISOString() },
    );
  });

  it('floors a cleared conversation at clearedAt', async () => {
    const clearedAt = new Date('2026-08-01T08:00:00.000Z');
    core.requireParticipant.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      clearedAt,
      leftAt: null,
    });

    await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
      kind: ConversationMediaKind.Media,
    });

    expect(galleryQuery.andWhere).toHaveBeenCalledWith(
      'm.created_at > :clearedAt',
      { clearedAt: clearedAt.toISOString() },
    );
  });

  it('applies neither bound for a current participant who never cleared', async () => {
    await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
      kind: ConversationMediaKind.Media,
    });

    expect(andWhereClauses()).not.toContain('m.created_at <= :leftAt');
    expect(andWhereClauses()).not.toContain('m.created_at > :clearedAt');
  });

  it('excludes messages this viewer hid for themselves', async () => {
    await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
      kind: ConversationMediaKind.Media,
    });

    const hideCall = andWhereCallContaining('"message_hides"');
    expect(hideCall).toBeDefined();
    expect(hideCall?.[0]).toContain('NOT EXISTS');
    expect(hideCall?.[1]).toEqual({ hidingUserId: VIEWER_ID });
  });

  it('excludes moderator takedowns and never reads soft-deleted rows', async () => {
    await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
      kind: ConversationMediaKind.Media,
    });

    expect(galleryQuery.andWhere).toHaveBeenCalledWith(
      notModeratedMessagePredicate('m'),
      { messageSubjectType: MESSAGE_SUBJECT_TYPE },
    );
    expect(galleryQuery.withDeleted).not.toHaveBeenCalled();
  });

  describe('kind filters', () => {
    it('media lists image and GIF messages', async () => {
      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Media,
      });

      expect(galleryQuery.andWhere).toHaveBeenCalledWith(
        'm.kind IN (:...mediaKinds)',
        { mediaKinds: [MessageKind.Image, MessageKind.Gif] },
      );
      expect(andWhereClauses()).not.toContain('m.body ~* :linkPattern');
    });

    it('documents lists document messages only', async () => {
      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Documents,
      });

      expect(galleryQuery.where).toHaveBeenCalledWith(
        'm.conversation_id = :id',
        {
          id: CONVERSATION_ID,
        },
      );
      expect(galleryQuery.andWhere).toHaveBeenCalledWith(
        'm.kind = :documentKind',
        { documentKind: MessageKind.Document },
      );
      expect(andWhereClauses()).not.toContain('m.kind IN (:...mediaKinds)');
    });

    it('links lists text messages whose body carries an http(s) address or a bare www. host', async () => {
      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Links,
      });

      expect(galleryQuery.where).toHaveBeenCalledWith(
        'm.conversation_id = :id',
        {
          id: CONVERSATION_ID,
        },
      );
      expect(galleryQuery.andWhere).toHaveBeenCalledWith('m.kind = :textKind', {
        textKind: MessageKind.User,
      });
      expect(LINK_BODY_PATTERN).toBe('(https?://|www\\.)');
      expect(galleryQuery.andWhere).toHaveBeenCalledWith(
        'm.body ~* :linkPattern',
        { linkPattern: '(https?://|www\\.)' },
      );
    });

    it('links keeps to plain text bubbles, so image captions and documents carrying a URL stay in their own tabs', async () => {
      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Links,
      });

      const kindClauses = andWhereClauses().filter((clause) =>
        clause.startsWith('m.kind'),
      );
      expect(kindClauses).toEqual(['m.kind = :textKind']);
      const textKindCall = andWhereCallContaining('m.kind = :textKind');
      expect(textKindCall?.[1]).toEqual({ textKind: MessageKind.User });
      expect(textKindCall?.[1]).not.toEqual({ textKind: MessageKind.Image });
      expect(textKindCall?.[1]).not.toEqual({
        textKind: MessageKind.Document,
      });
    });

    it('the link pattern matches both schemes and a bare www. host, and ignores plain words', () => {
      const linkExpression = new RegExp(LINK_BODY_PATTERN, 'i');

      expect(linkExpression.test('see https://example.org/lease')).toBe(true);
      expect(linkExpression.test('HTTP://example.org')).toBe(true);
      expect(linkExpression.test('the flat is on www.example.org')).toBe(true);
      expect(linkExpression.test('WWW.Example.org/viewing')).toBe(true);
      expect(linkExpression.test('the https thing we talked about')).toBe(
        false,
      );
      expect(linkExpression.test('the www thing we talked about')).toBe(false);
    });
  });

  describe('cursor pagination', () => {
    it('fetches limit + 1, returns limit newest first, and cursors the oldest returned row at its exact timestamp', async () => {
      const newest = makeMessageRow(
        '00000000-0000-4000-8000-000000000003',
        '2026-09-10T10:00:03.000Z',
        MessageKind.Image,
      );
      const middle = makeMessageRow(
        '00000000-0000-4000-8000-000000000002',
        '2026-09-10T10:00:02.000Z',
        MessageKind.Gif,
      );
      const extra = makeMessageRow(
        '00000000-0000-4000-8000-000000000001',
        '2026-09-10T10:00:01.000Z',
        MessageKind.Image,
      );
      galleryQuery.getRawAndEntities.mockResolvedValue({
        entities: [newest, middle, extra],
        raw: [
          { m_id: newest.id, cursor_created_at: '2026-09-10T10:00:03.000301Z' },
          { m_id: middle.id, cursor_created_at: '2026-09-10T10:00:02.123456Z' },
          { m_id: extra.id, cursor_created_at: '2026-09-10T10:00:01.000001Z' },
        ],
      });

      const page = await service.listConversationMedia(
        CONVERSATION_ID,
        VIEWER_ID,
        { kind: ConversationMediaKind.Media, limit: 2 },
      );

      expect(galleryQuery.take).toHaveBeenCalledWith(3);
      expect(galleryQuery.orderBy).toHaveBeenCalledWith('m.created_at', 'DESC');
      expect(galleryQuery.addOrderBy).toHaveBeenCalledWith('m.id', 'DESC');
      // An active participant (no `leftAt`) hydrates as a current member.
      expect(core.toMessageResponses).toHaveBeenCalledWith(
        [newest, middle],
        VIEWER_ID,
        false,
      );
      expect(page.data).toEqual([{ id: newest.id }, { id: middle.id }]);
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).toBe(
        encodeMessageHistoryCursor('2026-09-10T10:00:02.123456Z', middle.id),
      );
      expect(
        decodeMessageHistoryCursor(page.pageInfo.nextCursor as string),
      ).toEqual({ before: '2026-09-10T10:00:02.123456Z', beforeId: middle.id });
    });

    it('tells the hydration a member who left the group has left', async () => {
      core.requireParticipant.mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        clearedAt: null,
        leftAt: new Date('2026-09-01T12:00:00.000Z'),
      });
      const beforeLeaving = makeMessageRow(
        '00000000-0000-4000-8000-000000000005',
        '2026-08-31T09:00:00.000Z',
        MessageKind.Image,
      );
      galleryQuery.getRawAndEntities.mockResolvedValue({
        entities: [beforeLeaving],
        raw: [
          {
            m_id: beforeLeaving.id,
            cursor_created_at: '2026-08-31T09:00:00.000000Z',
          },
        ],
      });

      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Media,
      });

      expect(core.toMessageResponses).toHaveBeenCalledWith(
        [beforeLeaving],
        VIEWER_ID,
        true,
      );
    });

    it('reports the last page with hasMore false and a null cursor', async () => {
      const onlyRow = makeMessageRow(
        '00000000-0000-4000-8000-000000000009',
        '2026-09-10T10:00:00.000Z',
        MessageKind.Document,
      );
      galleryQuery.getRawAndEntities.mockResolvedValue({
        entities: [onlyRow],
        raw: [
          {
            m_id: onlyRow.id,
            cursor_created_at: '2026-09-10T10:00:00.000000Z',
          },
        ],
      });

      const page = await service.listConversationMedia(
        CONVERSATION_ID,
        VIEWER_ID,
        { kind: ConversationMediaKind.Documents, limit: 5 },
      );

      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
      expect(page.data).toEqual([{ id: onlyRow.id }]);
    });

    it('binds a decoded cursor onto the composite keyset predicate', async () => {
      const beforeId = '00000000-0000-4000-8000-000000000002';
      const cursor = encodeMessageHistoryCursor(
        '2026-09-10T10:00:02.123456Z',
        beforeId,
      );

      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Media,
        cursor,
      });

      expect(galleryQuery.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        { before: '2026-09-10T10:00:02.123456Z', beforeId },
      );
    });

    it('treats a malformed cursor as the first page', async () => {
      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Media,
        cursor: 'not-a-cursor',
      });

      expect(
        andWhereClauses().some((clause) => clause.includes(':before')),
      ).toBe(false);
    });
  });

  describe('limit clamp', () => {
    it.each([
      ['defaults to 30 when absent', undefined, 31],
      ['caps an oversized limit at 50', 500, 51],
      ['raises a zero limit to 1', 0, 2],
      ['keeps an in-range limit', 12, 13],
    ])('%s', async (_label, limit, expectedTake) => {
      await service.listConversationMedia(CONVERSATION_ID, VIEWER_ID, {
        kind: ConversationMediaKind.Media,
        limit,
      });

      expect(galleryQuery.take).toHaveBeenCalledWith(expectedTake);
    });
  });
});
