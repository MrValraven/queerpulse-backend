import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumThreadsService } from './forum-threads.service';

// A chainable query-builder stub whose terminal `getMany()` resolves to a
// configurable row list — mirrors `moderation.service.spec.ts`'s `qbStub`,
// which itself adapts `cursorPaginate`'s terminal-call shape.
function qbStub(rows: ForumThread[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['andWhere', 'orderBy', 'addOrderBy', 'take']) {
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

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    userId: 'author-1',
    slug: 'ava',
    firstName: 'Ava',
    lastName: 'Lee',
    avatarUrl: null,
    ...overrides,
  }) as Profile;

describe('ForumThreadsService', () => {
  let service: ForumThreadsService;
  let threads: {
    findOne: jest.Mock;
    exists: jest.Mock;
    increment: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let posts: { createQueryBuilder: jest.Mock };
  let profiles: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let blockFilter: {
    excludeHidden: jest.Mock;
    isBlockedEitherWay: jest.Mock;
  };

  beforeEach(async () => {
    threads = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      increment: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    posts = { createQueryBuilder: jest.fn(() => qbStub()) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    blockFilter = {
      excludeHidden: jest.fn((qb: unknown) => qb),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    };

    // Runs the transaction callback against a manager whose `getRepository`
    // resolves to the *same* mocked repos the test configures — mirrors
    // `communities.service.spec.ts`'s transaction stub.
    const threadsRepoInTx = {
      create: jest.fn((v: object) => v),
      save: jest.fn((t: unknown) =>
        Promise.resolve({
          id: 'thread-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(t as object),
        }),
      ),
    };
    const postsRepoInTx = {
      create: jest.fn((v: object) => v),
      save: jest.fn((p: unknown) =>
        Promise.resolve({
          id: 'post-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(p as object),
        }),
      ),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === ForumThread) return threadsRepoInTx;
        if (entity === ForumPost) return postsRepoInTx;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
    };
    dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForumThreadsService,
        { provide: getRepositoryToken(ForumThread), useValue: threads },
        { provide: getRepositoryToken(ForumPost), useValue: posts },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(ForumThreadsService);
  });

  describe('list', () => {
    it('filters by category when provided', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', 'housing', undefined, undefined);

      expect(qb.andWhere).toHaveBeenCalledWith('t.category = :category', {
        category: 'housing',
      });
    });

    it('does not filter by category when it is omitted', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        't.category = :category',
        expect.anything(),
      );
    });

    it('excludes blocked/muted authors in-query, keyed on the author column', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"t"."author_id"',
      );
    });

    it('returns a cursor page of ForumThreadResponse with resolved authors', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([baseProfile()]);

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
      );

      expect(page.data).toEqual([
        expect.objectContaining({
          id: 'thread-1',
          slug: 'hello-world',
          author: { handle: 'ava', displayName: 'Ava Lee', avatarUrl: null },
        }),
      ]);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    it('falls back to a placeholder author when the profile is missing', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([]);

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
      );

      expect(page.data[0].author).toEqual({
        handle: '',
        displayName: 'Member',
        avatarUrl: null,
      });
    });
  });

  describe('getBySlug', () => {
    it('404s an unknown slug', async () => {
      threads.findOne.mockResolvedValue(null);
      await expect(
        service.getBySlug('nope', 'viewer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the ForumThreadResponse for a known slug', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.getBySlug('hello-world', 'viewer-1');
      expect(res.slug).toBe('hello-world');
      expect(res.author.handle).toBe('ava');
    });

    it('404s a thread whose author is blocked either way', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      await expect(
        service.getBySlug('hello-world', 'viewer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        'viewer-1',
        'author-1',
      );
    });
  });

  describe('loadOr404', () => {
    it('skips the block check when no viewer is supplied', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await service.loadOr404('hello-world');

      expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('allocates a unique slug from the title and persists thread + OP post', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.create('author-1', {
        title: 'Hello, World!',
        body: 'First post body',
        category: 'general',
      });

      expect(threads.exists).toHaveBeenCalledWith({
        where: { slug: 'hello-world' },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(res).toEqual(
        expect.objectContaining({
          slug: 'hello-world',
          title: 'Hello, World!',
          category: 'general',
          isPinned: false,
          isLocked: false,
          replyCount: 0,
          author: { handle: 'ava', displayName: 'Ava Lee', avatarUrl: null },
        }),
      );
    });

    it('retries the slug when the base is already taken', async () => {
      threads.exists.mockResolvedValueOnce(true).mockResolvedValue(false);
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.create('author-1', {
        title: 'Hello, World!',
        body: 'First post body',
        category: 'general',
      });

      expect(res.slug).toMatch(/^hello-world-[0-9a-f]{6}$/);
    });
  });

  describe('markActivity', () => {
    it('increments replyCount and refreshes lastActivityAt', async () => {
      await service.markActivity('thread-1');

      expect(threads.increment).toHaveBeenCalledWith(
        { id: 'thread-1' },
        'replyCount',
        1,
      );
      const [idArg, patch] = threads.update.mock.calls[0] as [
        { id: string },
        { lastActivityAt: Date },
      ];
      expect(idArg).toEqual({ id: 'thread-1' });
      expect(patch.lastActivityAt).toBeInstanceOf(Date);
    });
  });
});
