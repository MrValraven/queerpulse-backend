import { ForumPost } from './entities/forum-post.entity';
import {
  applyReplyOrder,
  applyTopReplySeek,
  decodeTopRepliesCursor,
  encodeTopRepliesCursor,
  keysetForReplySort,
} from './forum-reply-sort';

// The reply sort bar used to be entirely client-side: "Newest" reversed
// whatever twenty replies had loaded and "Most helpful" ranked them on a
// demo-only flag. On a sixty-reply thread that showed the twenty OLDEST
// replies, reversed, labelled as the newest (C6/PRD-162). These cover the
// ordering and the cursor the server-side sort rides on.

function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    id: 'post-1',
    threadId: 'thread-1',
    parentPostId: null,
    authorId: 'author-1',
    body: 'hello',
    image: null,
    voteCount: 3,
    isOp: false,
    createdAt: new Date('2026-07-23T10:00:00.123Z'),
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    ...overrides,
  };
}

/** Records the ORDER BY / WHERE a sort applies, without a database. */
function makeQueryBuilder() {
  const orderByCalls: Array<[string, string]> = [];
  const andWhereCalls: Array<[string, Record<string, unknown>]> = [];
  interface RecordingQueryBuilder {
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    andWhere: jest.Mock;
  }
  const queryBuilder: RecordingQueryBuilder = {
    orderBy: jest.fn((column: string, direction: string) => {
      orderByCalls.push([column, direction]);
      return queryBuilder;
    }),
    addOrderBy: jest.fn((column: string, direction: string) => {
      orderByCalls.push([column, direction]);
      return queryBuilder;
    }),
    andWhere: jest.fn(
      (predicate: string, parameters: Record<string, unknown>) => {
        andWhereCalls.push([predicate, parameters]);
        return queryBuilder;
      },
    ),
  };
  return { queryBuilder, orderByCalls, andWhereCalls };
}

describe('keysetForReplySort', () => {
  it('orders oldest-first ascending and newest-first descending on the same column', () => {
    expect(keysetForReplySort('oldest')).toMatchObject({
      columnExpr: '"p"."created_at"',
      direction: 'ASC',
      kind: 'date',
    });
    expect(keysetForReplySort('newest')).toMatchObject({
      columnExpr: '"p"."created_at"',
      direction: 'DESC',
    });
  });

  it('declines to model `top`, which needs three columns in two directions', () => {
    expect(keysetForReplySort('top')).toBeUndefined();
  });
});

describe('top replies cursor', () => {
  it('round-trips the three sort columns', () => {
    const row = makePost({ id: 'post-9', voteCount: 12 });

    const decoded = decodeTopRepliesCursor(encodeTopRepliesCursor(row));

    expect(decoded).toEqual({
      voteCount: 12,
      createdAt: row.createdAt,
      id: 'post-9',
    });
  });

  it('keeps millisecond resolution, which the raw column comparison relies on', () => {
    const row = makePost({ createdAt: new Date('2026-07-23T10:00:00.123Z') });

    expect(
      decodeTopRepliesCursor(encodeTopRepliesCursor(row))?.createdAt.getTime(),
    ).toBe(row.createdAt.getTime());
  });

  it('treats any malformed or forged cursor as no cursor, never an error', () => {
    expect(decodeTopRepliesCursor('not-base64-at-all!!')).toBeNull();
    expect(
      decodeTopRepliesCursor(Buffer.from('1|2').toString('base64')),
    ).toBeNull();
    expect(
      decodeTopRepliesCursor(
        Buffer.from('abc|2026-07-23T10:00:00.000Z|post-1').toString('base64'),
      ),
    ).toBeNull();
    expect(
      decodeTopRepliesCursor(Buffer.from('3|never|post-1').toString('base64')),
    ).toBeNull();
  });
});

describe('applyTopReplySeek', () => {
  it('orders votes descending and falls back to the OLDEST reply', () => {
    const { queryBuilder, orderByCalls } = makeQueryBuilder();

    applyTopReplySeek(queryBuilder as never, undefined);

    expect(orderByCalls).toEqual([
      ['"p"."vote_count"', 'DESC'],
      ['"p"."created_at"', 'ASC'],
      ['"p"."id"', 'ASC'],
    ]);
  });

  it('adds no predicate on the first page', () => {
    const { queryBuilder, andWhereCalls } = makeQueryBuilder();

    applyTopReplySeek(queryBuilder as never, undefined);

    expect(andWhereCalls).toHaveLength(0);
  });

  it('seeks past the cursor row in two branches, because the columns disagree on direction', () => {
    const { queryBuilder, andWhereCalls } = makeQueryBuilder();
    const row = makePost({ id: 'post-9', voteCount: 12 });

    applyTopReplySeek(queryBuilder as never, encodeTopRepliesCursor(row));

    const [predicate, parameters] = andWhereCalls[0] ?? ['', {}];
    // Rows below the cursor's vote count qualify outright; rows ON it qualify
    // only when their (created_at, id) sorts after the cursor's. A row
    // constructor over the whole tuple would answer this wrong.
    expect(predicate).toContain('"p"."vote_count" < :topCursorVoteCount');
    expect(predicate).toContain('"p"."vote_count" = :topCursorVoteCount');
    expect(predicate).toContain(
      '("p"."created_at", "p"."id") > (:topCursorCreatedAt, :topCursorId)',
    );
    expect(parameters).toEqual({
      topCursorVoteCount: 12,
      topCursorCreatedAt: row.createdAt,
      topCursorId: 'post-9',
    });
  });

  it('ignores a forged cursor rather than failing the request', () => {
    const { queryBuilder, andWhereCalls } = makeQueryBuilder();

    applyTopReplySeek(queryBuilder as never, 'garbage');

    expect(andWhereCalls).toHaveLength(0);
  });
});

describe('applyReplyOrder', () => {
  it('orders descendants the same way as the roots, so siblings read in order at every depth', () => {
    const newest = makeQueryBuilder();
    applyReplyOrder(newest.queryBuilder as never, 'newest');
    expect(newest.orderByCalls).toEqual([
      ['"p"."created_at"', 'DESC'],
      ['"p"."id"', 'DESC'],
    ]);

    const oldest = makeQueryBuilder();
    applyReplyOrder(oldest.queryBuilder as never, 'oldest');
    expect(oldest.orderByCalls).toEqual([
      ['"p"."created_at"', 'ASC'],
      ['"p"."id"', 'ASC'],
    ]);

    const top = makeQueryBuilder();
    applyReplyOrder(top.queryBuilder as never, 'top');
    expect(top.orderByCalls).toEqual([
      ['"p"."vote_count"', 'DESC'],
      ['"p"."created_at"', 'ASC'],
      ['"p"."id"', 'ASC'],
    ]);
  });
});
