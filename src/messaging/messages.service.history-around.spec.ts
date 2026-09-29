import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { encodeMessageHistoryCursor } from './message-history-cursor';
import { MessageHistoryWindowPage, MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * PRD-401: `GET /conversations/:id/messages?around=<messageId>`. The window is
 * built from three queries in a fixed order (the target lookup, the older half,
 * the newer half), each a fresh builder from `createQueryBuilder`, so every
 * builder here is recorded and its result configured by position.
 */

const CONVERSATION_ID = '8b0c4c3e-6d0f-4a52-9d0b-3f8f0f6f2a01';
const VIEWER_ID = '1f7a3c55-2a9e-4c1b-8f7e-6a0b9d3c4e10';
const TARGET_ID = '4a2b6c8d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';

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

interface HistoryRow {
  id: string;
  exactCreatedAt: string;
}

function makeHistoryQuery(rows: HistoryRow[]): HistoryQueryMock {
  const query = {} as HistoryQueryMock;
  const chain = (): HistoryQueryMock => query;
  query.where = jest.fn(chain);
  query.andWhere = jest.fn(chain);
  query.withDeleted = jest.fn(chain);
  query.addSelect = jest.fn(chain);
  query.orderBy = jest.fn(chain);
  query.addOrderBy = jest.fn(chain);
  query.take = jest.fn(chain);
  query.getRawAndEntities = jest.fn().mockResolvedValue({
    entities: rows.map((row) => ({
      id: row.id,
      createdAt: new Date(row.exactCreatedAt),
    })),
    raw: rows.map((row) => ({
      m_id: row.id,
      cursor_created_at: row.exactCreatedAt,
    })),
  });
  query.getMany = jest.fn().mockResolvedValue([]);
  return query;
}

function row(id: string, exactCreatedAt: string): HistoryRow {
  return { id, exactCreatedAt };
}

const TARGET = row(TARGET_ID, '2026-03-10T12:00:00.123456Z');
const OLDER_1 = row(
  '0a000000-0000-4000-8000-000000000001',
  '2026-03-10T11:59:00.000001Z',
);
const OLDER_2 = row(
  '0a000000-0000-4000-8000-000000000002',
  '2026-03-10T11:58:00.000002Z',
);
const OLDER_3 = row(
  '0a000000-0000-4000-8000-000000000003',
  '2026-03-10T11:57:00.000003Z',
);
const NEWER_1 = row(
  '0b000000-0000-4000-8000-000000000001',
  '2026-03-10T12:01:00.000001Z',
);
const NEWER_2 = row(
  '0b000000-0000-4000-8000-000000000002',
  '2026-03-10T12:02:00.000002Z',
);
const NEWER_3 = row(
  '0b000000-0000-4000-8000-000000000003',
  '2026-03-10T12:03:00.000003Z',
);

describe('MessagesService.getMessages around a message (PRD-401)', () => {
  let service: MessagesService;
  let builders: HistoryQueryMock[];
  let queuedResults: HistoryRow[][];
  let core: { requireParticipant: jest.Mock; toMessageResponses: jest.Mock };
  let conversationKind: ConversationKind;
  let participant: Partial<ConversationParticipant>;
  let blockFilter: { excludeBlocked: jest.Mock };

  beforeEach(() => {
    builders = [];
    queuedResults = [];
    conversationKind = ConversationKind.Direct;
    participant = {
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      clearedAt: null,
      leftAt: null,
    };
    core = {
      requireParticipant: jest.fn(async () => participant),
      toMessageResponses: jest.fn(async (rows: Message[]) =>
        rows.map((message) => ({ id: message.id })),
      ),
    };
    blockFilter = {
      excludeBlocked: jest.fn((query: HistoryQueryMock) => {
        query.andWhere('BLOCK_FILTER');
        return query;
      }),
    };
    const empty = {} as Record<string, never>;
    service = new MessagesService(
      {
        findOne: jest.fn(async () => ({ kind: conversationKind })),
      } as unknown as Repository<Conversation>,
      empty as unknown as Repository<ConversationParticipant>,
      {
        createQueryBuilder: jest.fn(() => {
          const builder = makeHistoryQuery(queuedResults.shift() ?? []);
          builders.push(builder);
          return builder;
        }),
      } as unknown as Repository<Message>,
      empty as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      empty as unknown as EventEmitter2,
      empty as never,
      blockFilter as unknown as BlockFilterService,
      empty as never,
      empty as never,
      empty as never,
    );
  });

  async function loadWindow(limit: number): Promise<MessageHistoryWindowPage> {
    return (await service.getMessages(CONVERSATION_ID, VIEWER_ID, {
      around: TARGET_ID,
      limit,
    })) as MessageHistoryWindowPage;
  }

  it('centres the window on the target, newest first, with an older cursor from its oldest row', async () => {
    queuedResults = [[TARGET], [OLDER_1, OLDER_2, OLDER_3], [NEWER_1]];

    const page = await loadWindow(5);

    expect(page.data.map((message) => message.id)).toEqual([
      NEWER_1.id,
      TARGET.id,
      OLDER_1.id,
      OLDER_2.id,
    ]);
    expect(page.pageInfo).toEqual({
      nextCursor: encodeMessageHistoryCursor(
        OLDER_2.exactCreatedAt,
        OLDER_2.id,
      ),
      hasMore: true,
      hasNewer: false,
      newerAfter: null,
      newerAfterId: null,
    });
  });

  it('asks each half for one row past its share of the limit', async () => {
    queuedResults = [[TARGET], [], []];

    await loadWindow(5);

    const [targetQuery, olderQuery, newerQuery] = builders;
    expect(targetQuery!.take).toHaveBeenCalledWith(1);
    expect(olderQuery!.take).toHaveBeenCalledWith(3);
    expect(newerQuery!.take).toHaveBeenCalledWith(3);
  });

  it('hands the exact microsecond keyset of its newest row to the forward path when newer history exists', async () => {
    queuedResults = [[TARGET], [OLDER_1], [NEWER_1, NEWER_2, NEWER_3]];

    const page = await loadWindow(5);

    expect(page.data.map((message) => message.id)).toEqual([
      NEWER_2.id,
      NEWER_1.id,
      TARGET.id,
      OLDER_1.id,
    ]);
    expect(page.pageInfo.hasNewer).toBe(true);
    expect(page.pageInfo.newerAfter).toBe(NEWER_2.exactCreatedAt);
    expect(page.pageInfo.newerAfterId).toBe(NEWER_2.id);
    expect(page.pageInfo.hasMore).toBe(false);
    expect(page.pageInfo.nextCursor).toBeNull();
  });

  it('pages both halves from the target exact created_at text on the (created_at, id) keyset', async () => {
    queuedResults = [[TARGET], [], []];

    await loadWindow(30);

    const [targetQuery, olderQuery, newerQuery] = builders;
    expect(targetQuery!.andWhere).toHaveBeenCalledWith('m.id = :aroundId', {
      aroundId: TARGET_ID,
    });
    const anchor = {
      anchorCreatedAt: TARGET.exactCreatedAt,
      anchorId: TARGET.id,
    };
    expect(olderQuery!.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('(m.created_at, m.id) < '),
      anchor,
    );
    expect(olderQuery!.orderBy).toHaveBeenCalledWith('m.created_at', 'DESC');
    expect(newerQuery!.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('(m.created_at, m.id) > '),
      anchor,
    );
    expect(newerQuery!.orderBy).toHaveBeenCalledWith('m.created_at', 'ASC');
    for (const builder of builders) {
      expect(builder.withDeleted).toHaveBeenCalled();
    }
  });

  it('applies the clear floor, the leave ceiling, the reader hides and the group block filter to the target and both halves', async () => {
    conversationKind = ConversationKind.Group;
    participant = {
      ...participant,
      clearedAt: new Date('2026-01-01T00:00:00.000Z'),
      leftAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    queuedResults = [[TARGET], [], []];

    await loadWindow(30);

    expect(builders).toHaveLength(3);
    for (const builder of builders) {
      expect(builder.andWhere).toHaveBeenCalledWith(
        'm.created_at > :clearedAt',
        { clearedAt: '2026-01-01T00:00:00.000Z' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith('m.created_at <= :leftAt', {
        leftAt: '2026-06-01T00:00:00.000Z',
      });
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"mh"."user_id" = :hidingUserId'),
        { hidingUserId: VIEWER_ID },
      );
      expect(builder.andWhere).toHaveBeenCalledWith('BLOCK_FILTER');
    }
    expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
      expect.anything(),
      VIEWER_ID,
      '"m"."sender_id"',
      { unless: `"m"."kind" = 'system'` },
    );
    // A former member's bubbles render read-only, as on every history page.
    // PRD-423: the conversation row `getMessages` read rides along, so the
    // page learns it is a plain group with no lookup of its own.
    expect(core.toMessageResponses).toHaveBeenCalledWith(
      expect.any(Array),
      VIEWER_ID,
      true,
      {
        kind: ConversationKind.Group,
        isGoTogetherChat: false,
        eventMatchGroupId: null,
      },
    );
  });

  it('answers 404 for a target outside what the reader may see, and loads nothing around it', async () => {
    queuedResults = [[]];

    await expect(loadWindow(30)).rejects.toBeInstanceOf(NotFoundException);
    expect(builders).toHaveLength(1);
    expect(core.toMessageResponses).not.toHaveBeenCalled();
  });

  it.each([
    { cursor: 'b3BhcXVl' },
    { before: '2026-03-10T12:00:00.000Z' },
    { after: '2026-03-10T12:00:00.000Z' },
    { afterId: TARGET_ID },
  ])(
    'refuses around combined with another cursor (%o) before any lookup',
    async (otherCursor) => {
      await expect(
        service.getMessages(CONVERSATION_ID, VIEWER_ID, {
          around: TARGET_ID,
          ...otherCursor,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(core.requireParticipant).not.toHaveBeenCalled();
      expect(builders).toHaveLength(0);
    },
  );
});
