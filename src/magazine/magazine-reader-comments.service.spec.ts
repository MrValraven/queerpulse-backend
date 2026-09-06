import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MemberLookup } from '../common/member-ref';
import { MagazineReaderComment } from './entities/magazine-reader-comment.entity';
import { MagazineReaderCommentsService } from './magazine-reader-comments.service';

const ARTICLE = {
  id: 'article-1',
  slug: 'city-changed',
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface QueryBuilderMock {
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getManyAndCount: jest.Mock;
  getMany: jest.Mock;
}

interface RowsState {
  topLevel: MagazineReaderComment[];
  replies: MagazineReaderComment[];
}

function comment(
  overrides: Partial<MagazineReaderComment> = {},
): MagazineReaderComment {
  return {
    id: 'top-1',
    articleId: 'article-1',
    parentId: null,
    authorId: 'author-1',
    body: 'Great piece.',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function build() {
  const rows: RowsState = { topLevel: [], replies: [] };
  const queryBuilders: QueryBuilderMock[] = [];

  const makeQueryBuilder = (): QueryBuilderMock => {
    const queryBuilder: QueryBuilderMock = {
      where: jest.fn(() => queryBuilder),
      andWhere: jest.fn(() => queryBuilder),
      orderBy: jest.fn(() => queryBuilder),
      addOrderBy: jest.fn(() => queryBuilder),
      skip: jest.fn(() => queryBuilder),
      take: jest.fn(() => queryBuilder),
      getManyAndCount: jest.fn(() =>
        Promise.resolve([rows.topLevel, rows.topLevel.length]),
      ),
      getMany: jest.fn(() => Promise.resolve(rows.replies)),
    };
    return queryBuilder;
  };

  const comments = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((row: unknown) => row),
    save: jest.fn((row: unknown) =>
      Promise.resolve({
        id: 'c1',
        createdAt: new Date(),
        editedAt: null,
        deletedAt: null,
        ...(row as object),
      }),
    ),
    createQueryBuilder: jest.fn(() => {
      const queryBuilder = makeQueryBuilder();
      queryBuilders.push(queryBuilder);
      return queryBuilder;
    }),
  };
  const articles = { findOne: jest.fn().mockResolvedValue(ARTICLE) };
  const profiles = {} as never;
  const contentModeration = {
    excludeHidden: jest.fn((queryBuilder: unknown) => queryBuilder),
    statesFor: jest.fn().mockResolvedValue(new Map()),
    stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
  };
  // Blocks and mutes are enforced through the same `BlockFilterService` every
  // other launched content surface uses: `excludeHidden` in-query on the read
  // paths, `isBlockedEitherWay` on the reply write path.
  const blockFilter = {
    excludeHidden: jest.fn((queryBuilder: unknown) => queryBuilder),
    isBlockedEitherWay: jest.fn().mockResolvedValue(false),
  };
  jest.spyOn(MemberLookup.prototype, 'byUserIds').mockResolvedValue(new Map());
  const service = new MagazineReaderCommentsService(
    comments as never,
    articles as never,
    profiles,
    contentModeration as never,
    blockFilter as never,
  );
  return {
    service,
    comments,
    articles,
    contentModeration,
    blockFilter,
    queryBuilders,
    rows,
  };
}

const viewer = {
  userId: 'user-1',
  email: '',
  status: 'active',
  role: 'member',
};

describe('MagazineReaderCommentsService.list', () => {
  it('404s on an unpublished/unknown article slug', async () => {
    const { service, articles } = build();
    articles.findOne.mockResolvedValueOnce(null);
    await expect(service.list('nope', viewer)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns an empty page for a published article with no comments', async () => {
    const { service } = build();
    const page = await service.list('city-changed', viewer);
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('drops blocked and muted authors from the top-level query, in-query', async () => {
    const { service, blockFilter, queryBuilders } = build();
    await service.list('city-changed', viewer);
    expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
      queryBuilders[0],
      'user-1',
      '"c"."author_id"',
    );
  });

  it('excludes moderation-hidden top-level rows', async () => {
    const { service, contentModeration, queryBuilders } = build();
    await service.list('city-changed', viewer);
    expect(contentModeration.excludeHidden).toHaveBeenCalledWith(
      queryBuilders[0],
      ['magazine_comment'],
      '"c"."id"',
    );
  });

  it('applies the block/mute and moderation filters to the replies query too', async () => {
    const { service, blockFilter, contentModeration, queryBuilders, rows } =
      build();
    rows.topLevel = [comment()];
    await service.list('city-changed', viewer);

    expect(queryBuilders).toHaveLength(2);
    const repliesQueryBuilder = queryBuilders[1];
    expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
      repliesQueryBuilder,
      'user-1',
      '"c"."author_id"',
    );
    expect(contentModeration.excludeHidden).toHaveBeenCalledWith(
      repliesQueryBuilder,
      ['magazine_comment'],
      '"c"."id"',
    );
  });

  it('returns a moderation-hidden row as a tombstone, never a blank card with live actions', async () => {
    const { service, contentModeration, rows } = build();
    rows.topLevel = [comment({ id: 'top-1', authorId: 'user-1' })];
    contentModeration.statesFor.mockResolvedValueOnce(
      new Map([['top-1', { hidden: true, removed: false }]]),
    );

    const page = await service.list('city-changed', viewer);
    const [item] = page.items;

    expect(item?.deleted).toBe(true);
    expect(item?.body).toBe('');
    expect(item?.author.displayName).toBe('');
    // Even for its own author: a hidden row offers no edit or delete.
    expect(item?.canEdit).toBe(false);
    expect(item?.canDelete).toBe(false);
  });
});

describe('MagazineReaderCommentsService.create', () => {
  const author = {
    userId: 'author-1',
    email: '',
    status: 'active',
    role: 'member',
  };

  it('404s on an unpublished/unknown article slug', async () => {
    const { service, articles } = build();
    articles.findOne.mockResolvedValueOnce(null);
    await expect(service.create('nope', author, 'hi')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects replying to a reply (one level deep only)', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'reply-1',
      articleId: 'article-1',
      parentId: 'top-1',
      authorId: 'other-1',
      deletedAt: null,
    });
    await expect(
      service.create('city-changed', author, 'hi', 'reply-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects replying to a deleted comment', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'top-1',
      articleId: 'article-1',
      parentId: null,
      authorId: 'other-1',
      deletedAt: new Date(),
    });
    await expect(
      service.create('city-changed', author, 'hi', 'top-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s a reply under a comment whose author is blocked either way', async () => {
    const { service, comments, blockFilter } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'top-1',
      articleId: 'article-1',
      parentId: null,
      authorId: 'blocker-1',
      deletedAt: null,
    });
    blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);

    await expect(
      service.create('city-changed', author, 'hi', 'top-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      'author-1',
      'blocker-1',
    );
    expect(comments.save).not.toHaveBeenCalled();
  });

  it('still allows a reply under a muted author: a mute is a silence, not a severance', async () => {
    const { service, comments, blockFilter } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'top-1',
      articleId: 'article-1',
      parentId: null,
      authorId: 'muted-1',
      deletedAt: null,
    });
    blockFilter.isBlockedEitherWay.mockResolvedValueOnce(false);

    const result = await service.create('city-changed', author, 'hi', 'top-1');
    expect(result.parentId).toBe('top-1');
    expect(comments.save).toHaveBeenCalled();
  });

  it('creates a top-level comment', async () => {
    const { service, comments } = build();
    const result = await service.create('city-changed', author, 'Great piece.');
    expect(comments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 'article-1',
        parentId: null,
        authorId: 'author-1',
        body: 'Great piece.',
      }),
    );
    expect(result.body).toBe('Great piece.');
  });

  it('does not consult blocks for a top-level comment: there is no counterparty', async () => {
    const { service, blockFilter } = build();
    await service.create('city-changed', author, 'Great piece.');
    expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
  });
});

describe('MagazineReaderCommentsService.update/remove', () => {
  const author = {
    userId: 'author-1',
    email: '',
    status: 'active',
    role: 'member',
  };
  const stranger = { userId: 'x', email: '', status: 'active', role: 'member' };

  it('update: non-author is forbidden', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'c1',
      authorId: 'author-1',
      body: 'orig',
      deletedAt: null,
    });
    await expect(service.update('c1', stranger, 'hack')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('update: editing a deleted comment 404s', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'c1',
      authorId: 'author-1',
      body: 'orig',
      deletedAt: new Date(),
    });
    await expect(service.update('c1', author, 'new')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ENG-102 — `toReaderCommentResponse` already reports `canEdit: false` on a
  // moderated row, so the button is gone from the UI. These two pin the
  // ENDPOINT, which is what a direct PATCH actually hits: without the gate an
  // author rewrites the body of the row a moderator just took down.
  it.each([
    ['hidden', { hidden: true, removed: false }],
    ['removed', { hidden: false, removed: true }],
  ])(
    'update: the author cannot edit their own %s comment',
    async (_label, state) => {
      const { service, comments, contentModeration } = build();
      comments.findOne.mockResolvedValueOnce({
        id: 'c1',
        authorId: 'author-1',
        body: 'orig',
        deletedAt: null,
      });
      contentModeration.stateFor.mockResolvedValueOnce(state);
      await expect(service.update('c1', author, 'new')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(comments.save).not.toHaveBeenCalled();
    },
  );

  it('update: author edits their own comment, stamping editedAt', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'c1',
      authorId: 'author-1',
      body: 'orig',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    });
    const result = await service.update('c1', author, 'new body');
    expect(comments.save).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'new body',
        editedAt: expect.any(Date) as unknown,
      }),
    );
    expect(result.body).toBe('new body');
  });

  it('remove: non-author is forbidden', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'c1',
      authorId: 'author-1',
      body: 'orig',
      deletedAt: null,
    });
    await expect(service.remove('c1', stranger)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('remove: author soft-deletes their own comment, blanking the response', async () => {
    const { service, comments } = build();
    comments.findOne.mockResolvedValueOnce({
      id: 'c1',
      authorId: 'author-1',
      body: 'orig',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    });
    const result = await service.remove('c1', author);
    expect(comments.save).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) as unknown }),
    );
    expect(result.deleted).toBe(true);
    expect(result.body).toBe('');
  });
});
