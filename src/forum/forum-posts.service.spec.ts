import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { encodeCursor } from '../common/cursor-pagination';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumPostsService } from './forum-posts.service';
import { ForumThreadsService } from './forum-threads.service';

// A chainable query-builder stub whose terminal `getMany()` resolves to a
// configurable row list (mirrors `forum-threads.service.spec.ts`'s `qbStub`,
// itself adapted from `moderation.service.spec.ts`).
function qbStub(rows: ForumPost[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const baseThread = (overrides: Partial<ForumThread> = {}): ForumThread => ({
  id: 'thread-1',
  slug: 'hello-world',
  title: 'Hello world',
  authorId: 'author-1',
  category: 'general',
  isPinned: false,
  isLocked: false,
  replyCount: 0,
  lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const basePost = (overrides: Partial<ForumPost> = {}): ForumPost => ({
  id: 'post-1',
  threadId: 'thread-1',
  authorId: 'author-1',
  body: 'First post body',
  voteCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    userId: 'author-1',
    slug: 'ava',
    firstName: 'Ava',
    lastName: 'Lee',
    avatarUrl: null,
    ...overrides,
  }) as Profile;

describe('ForumPostsService', () => {
  let service: ForumPostsService;
  let posts: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let votes: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let blockFilter: { excludeHidden: jest.Mock };
  let threadsService: { loadOr404: jest.Mock; markActivity: jest.Mock };

  beforeEach(async () => {
    posts = {
      findOne: jest.fn(),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns (`id`, `createdAt`) so a mapper reading
      // them off a `save()` result never sees `undefined` (the A4 lesson —
      // mirrors `communities.service.spec.ts`'s `members.save` stub).
      save: jest.fn((p: unknown) =>
        Promise.resolve({
          id: 'post-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(p as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    votes = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    threadsService = {
      loadOr404: jest.fn().mockResolvedValue(baseThread()),
      markActivity: jest.fn().mockResolvedValue(undefined),
    };
    blockFilter = { excludeHidden: jest.fn((qb: unknown) => qb) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForumPostsService,
        { provide: getRepositoryToken(ForumPost), useValue: posts },
        { provide: getRepositoryToken(ForumPostVote), useValue: votes },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: ForumThreadsService, useValue: threadsService },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(ForumPostsService);
  });

  describe('listPosts', () => {
    it('404s an unknown thread slug', async () => {
      threadsService.loadOr404.mockRejectedValue(new NotFoundException());
      await expect(
        service.listPosts('nope', 'viewer-1', undefined, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes the query to the thread and orders oldest-first', async () => {
      const qb = qbStub([basePost()]);
      posts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('hello-world', 'viewer-1', undefined, undefined);

      expect(qb.where).toHaveBeenCalledWith('p.threadId = :threadId', {
        threadId: 'thread-1',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('p.createdAt', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('p.id', 'ASC');
    });

    // In-query, not post-query: the keyset LIMIT must count only visible
    // posts, otherwise a page comes back short (the flaw in
    // `FeedService.dropBlocked`).
    it('excludes blocked/muted authors in-query, keyed on the author column', async () => {
      const qb = qbStub([basePost()]);
      posts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('hello-world', 'viewer-1', undefined, undefined);

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"p"."author_id"',
      );
    });

    it('passes the viewer to the thread lookup so a blocked author 404s', async () => {
      await service.listPosts('hello-world', 'viewer-1', undefined, undefined);

      expect(threadsService.loadOr404).toHaveBeenCalledWith(
        'hello-world',
        'viewer-1',
      );
    });

    it('applies a `>` keyset predicate (ascending) when a cursor is given', async () => {
      const qb = qbStub([basePost()]);
      posts.createQueryBuilder.mockReturnValue(qb);
      const cursor = encodeCursor({
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        id: 'post-0',
      });

      await service.listPosts('hello-world', 'viewer-1', cursor, undefined);

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(p.createdAt, p.id) > (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
          cursorId: 'post-0',
        },
      );
    });

    it('reports hasMore + nextCursor when an extra row is fetched', async () => {
      const rows = [
        basePost({ id: 'post-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
        basePost({ id: 'post-2', createdAt: new Date('2026-01-02T00:00:00Z') }),
      ];
      posts.createQueryBuilder.mockReturnValue(qbStub(rows));
      profiles.find.mockResolvedValue([baseProfile()]);

      const page = await service.listPosts(
        'hello-world',
        'viewer-1',
        undefined,
        1,
      );

      expect(page.data).toHaveLength(1);
      expect(page.data[0].id).toBe('post-1');
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).toBe(encodeCursor(rows[0]));
    });

    it("resolves each post author and the viewer's own vote", async () => {
      posts.createQueryBuilder.mockReturnValue(qbStub([basePost()]));
      profiles.find.mockResolvedValue([baseProfile()]);
      votes.find.mockResolvedValue([
        { postId: 'post-1', userId: 'viewer-1', value: 1 },
      ]);

      const page = await service.listPosts(
        'hello-world',
        'viewer-1',
        undefined,
        undefined,
      );

      expect(page.data[0]).toEqual(
        expect.objectContaining({
          id: 'post-1',
          threadId: 'thread-1',
          author: { handle: 'ava', displayName: 'Ava Lee', avatarUrl: null },
          myVote: 1,
        }),
      );
    });
  });

  describe('reply', () => {
    it('404s an unknown thread slug', async () => {
      threadsService.loadOr404.mockRejectedValue(new NotFoundException());
      await expect(
        service.reply('nope', 'author-1', 'hi'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a reply to a locked thread', async () => {
      threadsService.loadOr404.mockResolvedValue(
        baseThread({ isLocked: true }),
      );
      await expect(
        service.reply('hello-world', 'author-1', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('persists the reply and bumps thread activity', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.reply('hello-world', 'author-1', 'A reply');

      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          authorId: 'author-1',
          body: 'A reply',
          voteCount: 0,
        }),
      );
      expect(threadsService.markActivity).toHaveBeenCalledWith('thread-1');
      expect(res).toEqual(
        expect.objectContaining({
          body: 'A reply',
          voteCount: 0,
          myVote: 0,
          author: { handle: 'ava', displayName: 'Ava Lee', avatarUrl: null },
        }),
      );
    });
  });

  describe('vote', () => {
    it('404s an unknown post', async () => {
      posts.findOne.mockResolvedValue(null);
      await expect(service.vote('nope', 'viewer-1', 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('toggles +1 then 0: upvotes, then removes the vote', async () => {
      const post = basePost({ voteCount: 0 });
      posts.findOne.mockResolvedValue(post);
      votes.findOne.mockResolvedValueOnce(null); // no existing vote yet

      const upvoted = await service.vote('post-1', 'viewer-1', 1);
      expect(votes.save).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-1',
          userId: 'viewer-1',
          value: 1,
        }),
      );
      expect(upvoted).toEqual({ voteCount: 1, myVote: 1 });

      // Second call sees the vote row that now "exists".
      votes.findOne.mockResolvedValueOnce({
        postId: 'post-1',
        userId: 'viewer-1',
        value: 1,
      });
      const removed = await service.vote('post-1', 'viewer-1', 0);
      expect(votes.delete).toHaveBeenCalledWith({
        postId: 'post-1',
        userId: 'viewer-1',
      });
      expect(removed).toEqual({ voteCount: 0, myVote: 0 });
    });

    it('is idempotent: upvoting twice does not double-count', async () => {
      const post = basePost({ voteCount: 1 });
      posts.findOne.mockResolvedValue(post);
      votes.findOne.mockResolvedValue({
        postId: 'post-1',
        userId: 'viewer-1',
        value: 1,
      });

      const res = await service.vote('post-1', 'viewer-1', 1);
      expect(votes.save).not.toHaveBeenCalled();
      expect(res).toEqual({ voteCount: 1, myVote: 1 });
    });

    it('is idempotent: removing an absent vote does not go negative', async () => {
      const post = basePost({ voteCount: 0 });
      posts.findOne.mockResolvedValue(post);
      votes.findOne.mockResolvedValue(null);

      const res = await service.vote('post-1', 'viewer-1', 0);
      expect(votes.delete).not.toHaveBeenCalled();
      expect(res).toEqual({ voteCount: 0, myVote: 0 });
    });
  });
});
