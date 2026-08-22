import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MemberLookup } from '../common/member-ref';
import { MagazineReaderCommentsService } from './magazine-reader-comments.service';

const ARTICLE = {
  id: 'article-1',
  slug: 'city-changed',
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function build() {
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
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    }),
  };
  const articles = { findOne: jest.fn().mockResolvedValue(ARTICLE) };
  const profiles = {} as never;
  const contentModeration = {
    excludeHidden: jest.fn((qb: unknown) => qb),
    statesFor: jest.fn().mockResolvedValue(new Map()),
    stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
  };
  jest.spyOn(MemberLookup.prototype, 'byUserIds').mockResolvedValue(new Map());
  const service = new MagazineReaderCommentsService(
    comments as never,
    articles as never,
    profiles,
    contentModeration as never,
  );
  return { service, comments, articles, contentModeration };
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
      deletedAt: new Date(),
    });
    await expect(
      service.create('city-changed', author, 'hi', 'top-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
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
