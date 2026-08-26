import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { TopicPostLinkService } from '../content/topic-post-link.service';
import { ModAuditService } from '../moderation/mod-audit.service';
import { AccessTier } from '../communities/entities/community.entity';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumThreadsService } from './forum-threads.service';

// A chainable query-builder stub whose terminal `getMany()` resolves to a
// configurable row list — mirrors `moderation.service.spec.ts`'s `qbStub`,
// which itself adapts `cursorPaginate`'s terminal-call shape.
//
// Typed (rather than `Record<string, jest.Mock>`) for two reasons: a named
// property isn't subject to `noUncheckedIndexedAccess` the way an index
// signature is (that's what was making `qb.andWhere!` need a non-null
// assertion), and giving each mock's call-argument tuple a real type (not
// `any`) lets `.mock.calls`/`toHaveBeenCalledWith` assertions narrow safely
// instead of tripping `no-unsafe-*`.
interface QbStub {
  where: jest.Mock<QbStub, unknown[]>;
  andWhere: jest.Mock<QbStub, unknown[]>;
  limit: jest.Mock<QbStub, unknown[]>;
  offset: jest.Mock<QbStub, unknown[]>;
  orderBy: jest.Mock<QbStub, unknown[]>;
  addOrderBy: jest.Mock<QbStub, unknown[]>;
  take: jest.Mock<QbStub, unknown[]>;
  select: jest.Mock<QbStub, unknown[]>;
  addSelect: jest.Mock<QbStub, unknown[]>;
  groupBy: jest.Mock<QbStub, unknown[]>;
  getMany: jest.Mock<Promise<ForumThread[]>, []>;
  getRawMany: jest.Mock<Promise<unknown[]>, []>;
}

function qbStub(rows: ForumThread[] = []): QbStub {
  const qb: QbStub = {
    where: jest.fn<QbStub, unknown[]>(),
    andWhere: jest.fn<QbStub, unknown[]>(),
    limit: jest.fn<QbStub, unknown[]>(),
    offset: jest.fn<QbStub, unknown[]>(),
    orderBy: jest.fn<QbStub, unknown[]>(),
    addOrderBy: jest.fn<QbStub, unknown[]>(),
    take: jest.fn<QbStub, unknown[]>(),
    select: jest.fn<QbStub, unknown[]>(),
    addSelect: jest.fn<QbStub, unknown[]>(),
    groupBy: jest.fn<QbStub, unknown[]>(),
    getMany: jest.fn<Promise<ForumThread[]>, []>(),
    getRawMany: jest.fn<Promise<unknown[]>, []>(),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.limit.mockReturnValue(qb);
  qb.offset.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.groupBy.mockReturnValue(qb);
  qb.getMany.mockResolvedValue(rows);
  qb.getRawMany.mockResolvedValue([]);
  return qb;
}

// A chainable `Community` query-builder stub for `isCommunityHiddenFrom`'s
// existence probe (`this.threads.manager.createQueryBuilder(Community, 'com')`):
// its terminal `getExists()` resolves to whether the thread's Private community
// hides itself from the viewer (H1).
function communityAccessQbStub(hidden: boolean) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getExists = jest.fn().mockResolvedValue(hidden);
  return qb;
}

const baseThread = (overrides: Partial<ForumThread> = {}): ForumThread => ({
  id: 'thread-1',
  slug: 'hello-world',
  title: 'Hello world',
  authorId: 'author-1',
  category: 'general',
  communityId: null,
  isPinned: false,
  pinnedAt: null,
  isLocked: false,
  lockReason: null,
  isOfficial: false,
  acceptedPostId: null,
  tags: [],
  opVoteCount: 0,
  replyCount: 0,
  lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const moderator: CurrentUserData = {
  userId: 'mod-1',
  email: 'mod@example.com',
  status: 'active',
  role: 'moderator',
};

const member: CurrentUserData = {
  userId: 'member-1',
  email: 'member@example.com',
  status: 'active',
  role: 'member',
};

const admin: CurrentUserData = {
  userId: 'admin-1',
  email: 'admin@example.com',
  status: 'active',
  role: 'admin',
};

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
    count: jest.Mock;
    increment: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { createQueryBuilder: jest.Mock };
  };
  let posts: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let votes: { find: jest.Mock; findOne: jest.Mock };
  let profiles: { find: jest.Mock };
  let edits: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  // The transaction manager the callback runs against — `markActivity` now
  // bumps replyCount/lastActivityAt through it rather than the thread repo.
  let txManager: { increment: jest.Mock; update: jest.Mock };
  let blockFilter: {
    excludeHidden: jest.Mock;
    isBlockedEitherWay: jest.Mock;
  };
  let mentions: { notify: jest.Mock };

  beforeEach(async () => {
    threads = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      increment: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((thread: unknown) => Promise.resolve(thread)),
      createQueryBuilder: jest.fn(() => qbStub()),
      // Backs `isCommunityHiddenFrom`'s `Community` existence probe. Default:
      // not hidden (community-scoped threads pass the access gate) so tests
      // that don't opt into a Private community aren't affected.
      manager: {
        createQueryBuilder: jest.fn(() => communityAccessQbStub(false)),
      },
    };
    posts = {
      createQueryBuilder: jest.fn(() => qbStub()),
      // `toThreadResponses` batch-loads OP posts; `resolveOp`/`updateThreadTitle`
      // point-load the single OP. Default: no OP found.
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((post: unknown) => Promise.resolve(post)),
    };
    // The viewer's votes on OP posts — batched (`find`) on lists, point
    // (`findOne`) on single-thread echoes. Default: no vote cast.
    votes = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    edits = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    blockFilter = {
      excludeHidden: jest.fn((qb: unknown) => qb),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    };
    // `create` fires a mention scan on the OP body; return no notified users.
    mentions = { notify: jest.fn().mockResolvedValue(new Set<string>()) };

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
    txManager = {
      increment: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      ...txManager,
      // `updateThreadTitle` writes the edit snapshot + OP + thread through the
      // manager directly (not via a repo), so it needs `create`/`save` too.
      create: jest.fn((_entity: unknown, value: object) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
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
        { provide: getRepositoryToken(ForumPostVote), useValue: votes },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(ForumPostEdit), useValue: edits },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: MentionNotificationService, useValue: mentions },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: CommunityMembershipService,
          useValue: { assertMemberBySlug: jest.fn() },
        },
        // `TopicPostLinkService` (thread-create tag reconciliation) and
        // `ModAuditService` (BE-COM-19's lock/pin/official audit rows) are
        // constructor dependencies of the service under test — stubbed here
        // so Nest can instantiate it; neither is exercised by these specs.
        {
          provide: TopicPostLinkService,
          useValue: { linkThread: jest.fn() },
        },
        { provide: ModAuditService, useValue: { writeAuditLog: jest.fn() } },
        // SOC-13 thread following — the service resolves `isSubscribed` on
        // every read path and auto-subscribes an author on create.
        {
          provide: ForumSubscriptionsService,
          useValue: {
            isSubscribed: jest.fn().mockResolvedValue(false),
            subscribedThreadIds: jest.fn().mockResolvedValue(new Set()),
            subscribe: jest.fn(),
            subscribeQuietly: jest.fn(),
            unsubscribe: jest.fn(),
          },
        },
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

    it('excludes pinned threads (they render in their own bucket)', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      expect(qb.andWhere).toHaveBeenCalledWith('t.is_pinned = false');
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

      expect(page.data[0]!.author).toEqual({
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

    it('skips the community access probe for a flat/global thread (H1)', async () => {
      threads.findOne.mockResolvedValue(baseThread({ communityId: null }));

      await service.loadOr404('hello-world', 'viewer-1');

      expect(threads.manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('404s a non-member reading a Private-community thread (H1)', async () => {
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'com-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(true),
      );

      await expect(
        service.loadOr404('hello-world', 'outsider-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the thread for a roster member of the community (H1)', async () => {
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'com-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(false),
      );

      const thread = await service.loadOr404('hello-world', 'member-1');

      expect(thread.slug).toBe('hello-world');
    });

    it('bypasses the community access gate for a privileged caller (H1)', async () => {
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'com-1' }));
      // Even though the probe would report the community hidden, the bypass
      // skips it entirely so a moderator can still act on the thread.
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(true),
      );

      const thread = await service.loadOr404('hello-world', 'mod-1', {
        bypassCommunityAccess: true,
      });

      expect(thread.slug).toBe('hello-world');
      expect(threads.manager.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('list community access (H1)', () => {
    it('gates the browse list on the community access predicate', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      const accessCall = qb.andWhere.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('access_tier'),
      );
      expect(accessCall).toBeDefined();
      expect(accessCall?.[1]).toEqual({
        privateTier: AccessTier.Private,
        viewerId: 'viewer-1',
      });
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

    it('posts as "QueerPulse Official" when the caller is an admin and asks for it', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.create(
        'author-1',
        {
          title: 'Hello, World!',
          body: 'First post body',
          category: 'general',
          isOfficial: true,
        },
        false,
        true,
      );

      expect(res.author).toEqual({
        handle: 'queerpulse',
        displayName: 'QueerPulse',
        avatarUrl: null,
        official: true,
      });
    });

    it('ignores isOfficial from a non-admin caller', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.create(
        'author-1',
        {
          title: 'Hello, World!',
          body: 'First post body',
          category: 'general',
          isOfficial: true,
        },
        false,
        false,
      );

      expect(res.author).toEqual({
        handle: 'ava',
        displayName: 'Ava Lee',
        avatarUrl: null,
      });
    });
  });

  describe('markActivity', () => {
    it('increments replyCount and refreshes lastActivityAt', async () => {
      await service.markActivity('thread-1');

      // Both writes now run inside one transaction against the manager.
      expect(txManager.increment).toHaveBeenCalledWith(
        ForumThread,
        { id: 'thread-1' },
        'replyCount',
        1,
      );
      const [entity, idArg, patch] = txManager.update.mock.calls[0] as [
        unknown,
        { id: string },
        { lastActivityAt: Date },
      ];
      expect(entity).toBe(ForumThread);
      expect(idArg).toEqual({ id: 'thread-1' });
      expect(patch.lastActivityAt).toBeInstanceOf(Date);
    });
  });

  describe('list sort', () => {
    it('orders by op_vote_count DESC for sort=top', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'top');

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."op_vote_count"', 'DESC');
    });

    it('orders by last_activity_at DESC for sort=active', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'active');

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."last_activity_at"', 'DESC');
    });

    it('narrows to reply-less threads on the created_at keyset for sort=unanswered', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        'unanswered',
      );

      expect(qb.andWhere).toHaveBeenCalledWith('t.reply_count = 0');
      // Still the default createdAt keyset (raw ms-precision column), not a
      // swapped leading column.
      expect(qb.orderBy).toHaveBeenCalledWith('"t"."created_at"', 'DESC');
    });

    it('uses the default created_at keyset for sort=new (and when omitted)', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'new');

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."created_at"', 'DESC');
      expect(qb.andWhere).not.toHaveBeenCalledWith('t.reply_count = 0');
    });
  });

  describe('list q/tag filters', () => {
    it('folds an escaped title ILIKE for q', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '  rent  ',
      );

      expect(qb.andWhere).toHaveBeenCalledWith('t.title ILIKE :q', {
        q: '%rent%',
      });
    });

    it('normalizes a filter tag and matches it against the tags array', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        undefined,
        '#Housing',
      );

      expect(qb.andWhere).toHaveBeenCalledWith(':tag = ANY(t.tags)', {
        tag: 'housing',
      });
    });

    it('applies neither filter when q is blank and tag is absent', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '   ',
      );

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        't.title ILIKE :q',
        expect.anything(),
      );
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        ':tag = ANY(t.tags)',
        expect.anything(),
      );
    });
  });

  describe('list OP fields', () => {
    it('batches OP posts + the viewer vote onto each card (no N+1)', async () => {
      const qb = qbStub([baseThread({ opVoteCount: 5, tags: ['housing'] })]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.find.mockResolvedValue([{ id: 'op-1', threadId: 'thread-1' }]);
      votes.find.mockResolvedValue([{ postId: 'op-1', value: 1 }]);

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
      );

      // One OP-post query and one vote query for the whole page.
      expect(posts.find).toHaveBeenCalledTimes(1);
      expect(votes.find).toHaveBeenCalledTimes(1);
      expect(page.data[0]).toEqual(
        expect.objectContaining({
          opPostId: 'op-1',
          opVoteCount: 5,
          myVote: 1,
          tags: ['housing'],
        }),
      );
    });

    it('defaults opPostId/myVote when the OP post is missing', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.find.mockResolvedValue([]);

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
      );

      expect(page.data[0]).toEqual(
        expect.objectContaining({ opPostId: '', myVote: 0 }),
      );
      // No OP posts → skip the vote query entirely.
      expect(votes.find).not.toHaveBeenCalled();
    });
  });

  describe('getBySlug OP fields', () => {
    it('resolves the OP post id and the viewer vote', async () => {
      threads.findOne.mockResolvedValue(baseThread({ opVoteCount: 3 }));
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue({ id: 'op-1', threadId: 'thread-1' });
      votes.findOne.mockResolvedValue({ postId: 'op-1', value: 1 });

      const res = await service.getBySlug('hello-world', 'viewer-1');

      expect(res.opPostId).toBe('op-1');
      expect(res.opVoteCount).toBe(3);
      expect(res.myVote).toBe(1);
    });
  });

  describe('counts', () => {
    it('groups by category and sums an all total, honoring the block filter', async () => {
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([
        { category: 'general', count: '4' },
        { category: 'housing', count: '2' },
      ]);
      threads.createQueryBuilder.mockReturnValue(qb);

      const result = await service.counts('viewer-1', undefined, undefined);

      expect(qb.groupBy).toHaveBeenCalledWith('t.category');
      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"t"."author_id"',
      );
      expect(result).toEqual({ all: 6, general: 4, housing: 2 });
    });

    it('returns just { all: 0 } when there are no visible threads', async () => {
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      const result = await service.counts('viewer-1', undefined, undefined);

      expect(result).toEqual({ all: 0 });
    });

    it('folds q/tag into the counts query', async () => {
      const qb = qbStub();
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.counts('viewer-1', 'rent', '#Housing');

      expect(qb.andWhere).toHaveBeenCalledWith('t.title ILIKE :q', {
        q: '%rent%',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(':tag = ANY(t.tags)', {
        tag: 'housing',
      });
    });
  });

  describe('setLocked', () => {
    it('locks a thread for a moderator and echoes the updated state', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isLocked: false }));
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setLocked('hello-world', moderator, true);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isLocked).toBe(true);
      expect(res.isLocked).toBe(true);
    });

    it('unlocks a thread for a moderator', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isLocked: true }));
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setLocked('hello-world', moderator, false);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isLocked).toBe(false);
      expect(res.isLocked).toBe(false);
    });

    it('forbids a non-moderator before touching the thread', async () => {
      await expect(
        service.setLocked('hello-world', member, true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(threads.findOne).not.toHaveBeenCalled();
      expect(threads.save).not.toHaveBeenCalled();
    });

    it('is a no-op write when already in the target state', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isLocked: true }));
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.setLocked('hello-world', moderator, true);

      expect(threads.save).not.toHaveBeenCalled();
    });
  });

  describe('setPinned', () => {
    it('pins a thread for a moderator, stamping pinnedAt', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isPinned: false }));
      threads.count.mockResolvedValue(0);
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setPinned('hello-world', moderator, true);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isPinned).toBe(true);
      expect(saved.pinnedAt).toBeInstanceOf(Date);
      expect(res.isPinned).toBe(true);
    });

    it('unpins a thread for a moderator, clearing pinnedAt', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ isPinned: true, pinnedAt: new Date() }),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setPinned('hello-world', moderator, false);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isPinned).toBe(false);
      expect(saved.pinnedAt).toBeNull();
      expect(res.isPinned).toBe(false);
    });

    it('forbids a non-moderator before touching the thread', async () => {
      await expect(
        service.setPinned('hello-world', member, true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(threads.findOne).not.toHaveBeenCalled();
      expect(threads.save).not.toHaveBeenCalled();
    });

    it('is a no-op write when already in the target state', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ isPinned: true, pinnedAt: new Date() }),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.setPinned('hello-world', moderator, true);

      expect(threads.save).not.toHaveBeenCalled();
    });

    it('rejects pinning past the cap', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isPinned: false }));
      threads.count.mockResolvedValue(3);

      await expect(
        service.setPinned('hello-world', moderator, true),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(threads.save).not.toHaveBeenCalled();
    });

    it('does not check the cap when unpinning', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ isPinned: true, pinnedAt: new Date() }),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.setPinned('hello-world', moderator, false);

      expect(threads.count).not.toHaveBeenCalled();
    });
  });

  describe('setOfficial', () => {
    it('marks a thread official and swaps the displayed author', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isOfficial: false }));
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setOfficial('hello-world', admin, true);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isOfficial).toBe(true);
      expect(res.author).toEqual({
        handle: 'queerpulse',
        displayName: 'QueerPulse',
        avatarUrl: null,
        official: true,
      });
    });

    it('unmarks a thread official, reverting to the real author', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isOfficial: true }));
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setOfficial('hello-world', admin, false);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isOfficial).toBe(false);
      expect(res.author).toEqual({
        handle: 'ava',
        displayName: 'Ava Lee',
        avatarUrl: null,
      });
    });

    it('is a no-op write when already in the target state', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isOfficial: true }));
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.setOfficial('hello-world', admin, true);

      expect(threads.save).not.toHaveBeenCalled();
    });
  });

  describe('listPinned', () => {
    it('queries pinned threads honoring category + block filter, capped and ordered by pinnedAt', async () => {
      const qb = qbStub([baseThread({ isPinned: true, pinnedAt: new Date() })]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([baseProfile()]);

      const result = await service.listPinned('viewer-1', 'housing', false);

      expect(qb.andWhere).toHaveBeenCalledWith('t.is_pinned = true');
      expect(qb.andWhere).toHaveBeenCalledWith('t.category = :category', {
        category: 'housing',
      });
      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"t"."author_id"',
      );
      expect(qb.orderBy).toHaveBeenCalledWith('t.pinned_at', 'DESC');
      expect(qb.take).toHaveBeenCalledWith(3);
      expect(result).toEqual([expect.objectContaining({ isPinned: true })]);
    });

    it('omits the category filter when not provided', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.listPinned('viewer-1', undefined, false);

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        't.category = :category',
        expect.anything(),
      );
    });
  });

  describe('OP card moderation/lock flags', () => {
    // A resolved OP post the single-thread paths hand the mapper. Live +
    // authored by the thread author by default.
    const opPost = (overrides: Record<string, unknown> = {}) => ({
      id: 'op-1',
      threadId: 'thread-1',
      authorId: 'author-1',
      deletedAt: null,
      editedAt: null,
      ...overrides,
    });

    it('getBySlug: the OP author can delete + (once edited) view history; a member cannot lock', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue(opPost({ editedAt: new Date() }));

      const res = await service.getBySlug('hello-world', 'author-1', false);

      expect(res.canDelete).toBe(true);
      expect(res.canViewHistory).toBe(true);
      expect(res.canRestore).toBe(false);
      expect(res.canLock).toBe(false);
    });

    it('getBySlug: a moderator gets canLock + canDelete on another member OP', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue(opPost());

      const res = await service.getBySlug('hello-world', 'mod-1', true);

      expect(res.canLock).toBe(true);
      expect(res.canDelete).toBe(true);
      expect(res.canViewHistory).toBe(false);
    });

    it('getBySlug: a tombstoned OP offers restore (not delete) to a moderator', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue(opPost({ deletedAt: new Date() }));

      const res = await service.getBySlug('hello-world', 'mod-1', true);

      expect(res.canRestore).toBe(true);
      expect(res.canDelete).toBe(false);
    });

    it('list: the OP card flags reflect a moderator viewer', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.find.mockResolvedValue([opPost()]);

      const page = await service.list(
        'mod-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );

      expect(page.data[0]!.canLock).toBe(true);
      expect(page.data[0]!.canDelete).toBe(true);
    });

    it('create: the author can delete the fresh OP but not lock (non-moderator)', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.create('author-1', {
        title: 'Hello, World!',
        body: 'First post body',
        category: 'general',
      });

      expect(res.canDelete).toBe(true);
      expect(res.canLock).toBe(false);
      expect(res.canViewHistory).toBe(false);
    });

    it('setLocked: a moderator gets canLock on the echo', async () => {
      threads.findOne.mockResolvedValue(baseThread({ isLocked: false }));
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue(opPost());

      const res = await service.setLocked('hello-world', moderator, true);

      expect(res.canLock).toBe(true);
    });
  });

  describe('tags persistence', () => {
    it('normalizes tags on create (trim, lowercase, strip #, dedupe, cap 5)', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);
      let createdThread: Partial<ForumThread> | undefined;
      // Capture what the in-transaction repo was asked to create.
      dataSource.transaction.mockImplementation(
        async (cb: (m: unknown) => Promise<unknown>) =>
          cb({
            increment: jest.fn(),
            update: jest.fn(),
            getRepository: (entity: unknown) => {
              if (entity === ForumThread) {
                return {
                  create: (value: Partial<ForumThread>) => {
                    createdThread = value;
                    return value;
                  },
                  save: (thread: unknown) =>
                    Promise.resolve({
                      id: 'thread-1',
                      createdAt: new Date('2026-01-01T00:00:00.000Z'),
                      ...(thread as object),
                    }),
                };
              }
              return {
                create: (value: object) => value,
                save: (post: unknown) =>
                  Promise.resolve({ id: 'op-1', ...(post as object) }),
              };
            },
          }),
      );

      await service.create('author-1', {
        title: 'Hello, World!',
        body: 'First post body',
        category: 'general',
        tags: ['  Housing ', '#housing', 'RENT', '', 'a', 'b', 'c', 'd'],
      });

      // deduped (housing once), '#'-stripped, lowercased, empties dropped,
      // capped at 5.
      expect(createdThread?.tags).toEqual(['housing', 'rent', 'a', 'b', 'c']);
    });

    it('replaces tags on update when the field is provided', async () => {
      threads.findOne.mockResolvedValue(baseThread({ tags: ['old'] }));
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        body: 'b',
      });

      const res = await service.updateThread(
        'hello-world',
        { userId: 'author-1', email: '', status: 'active', role: 'member' },
        'New title',
        ['#New', 'new', 'shiny'],
      );

      expect(res.tags).toEqual(['new', 'shiny']);
    });

    it('leaves tags untouched on update when the field is omitted', async () => {
      threads.findOne.mockResolvedValue(baseThread({ tags: ['keep'] }));
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        body: 'b',
      });

      const res = await service.updateThread(
        'hello-world',
        { userId: 'author-1', email: '', status: 'active', role: 'member' },
        'New title',
      );

      expect(res.tags).toEqual(['keep']);
    });
  });

  // ── SOC-13: accepted answer, tag permissions, unanswered ─────────────────
  describe('accepted answer and tag editing', () => {
    const actor = (userId: string, role = 'member'): CurrentUserData => ({
      userId,
      email: '',
      status: 'active',
      role,
    });

    it('lets the thread author mark a reply as the answer', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      posts.findOne.mockResolvedValue({
        id: 'reply-1',
        threadId: 'thread-1',
        isOp: false,
        deletedAt: null,
      });
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setAcceptedPost(
        'hello-world',
        actor('author-1'),
        'reply-1',
      );

      expect(res.acceptedPostId).toBe('reply-1');
    });

    it('lets a moderator who is not the author accept, so a quiet thread can still resolve', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      posts.findOne.mockResolvedValue({
        id: 'reply-1',
        threadId: 'thread-1',
        isOp: false,
        deletedAt: null,
      });
      profiles.find.mockResolvedValue([baseProfile()]);

      await expect(
        service.setAcceptedPost(
          'hello-world',
          actor('someone-else', 'moderator'),
          'reply-1',
        ),
      ).resolves.toMatchObject({ acceptedPostId: 'reply-1' });
    });

    it('refuses an accept from anyone else', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await expect(
        service.setAcceptedPost('hello-world', actor('stranger'), 'reply-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to make the opening post its own answer', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        isOp: true,
        deletedAt: null,
      });

      await expect(
        service.setAcceptedPost('hello-world', actor('author-1'), 'op-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('clears the mark when no post id is sent', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ acceptedPostId: 'reply-1' }),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      const res = await service.setAcceptedPost(
        'hello-world',
        actor('author-1'),
        null,
      );

      expect(res.acceptedPostId).toBeNull();
      expect(posts.findOne).not.toHaveBeenCalled();
    });

    it('narrows the unanswered sort on the accepted mark, not on the reply count', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        'unanswered',
      );

      expect(qb.andWhere).toHaveBeenCalledWith('t.accepted_post_id IS NULL');
      expect(qb.andWhere).not.toHaveBeenCalledWith('t.reply_count = 0');
    });

    it('lets a moderator re-file a thread they did not write', async () => {
      threads.findOne.mockResolvedValue(baseThread({ tags: ['old'] }));
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        body: 'b',
      });

      const res = await service.updateThread(
        'hello-world',
        actor('someone-else', 'moderator'),
        undefined,
        ['Filed'],
      );

      expect(res.tags).toEqual(['filed']);
    });

    it('still refuses a title edit from a moderator who is not the author', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await expect(
        service.updateThread(
          'hello-world',
          actor('someone-else', 'moderator'),
          'Rewritten by staff',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('writes no edit revision for a tags-only patch', async () => {
      threads.findOne.mockResolvedValue(baseThread({ tags: ['old'] }));
      profiles.find.mockResolvedValue([baseProfile()]);
      // The service stamps `editedAt` on the OP in the SAME branch that writes
      // the revision, so an untouched `editedAt` is the observable proof that
      // no phantom "edited" mark was left by a tags-only patch.
      const opPost: {
        id: string;
        threadId: string;
        body: string;
        editedAt?: Date;
      } = { id: 'op-1', threadId: 'thread-1', body: 'b' };
      posts.findOne.mockResolvedValue(opPost);

      await service.updateThread('hello-world', actor('author-1'), undefined, [
        'new',
      ]);

      expect(opPost.editedAt).toBeUndefined();
    });
  });

  // --- SOC-08: ranked, accent-insensitive thread search ---------------------
  describe('searchByText', () => {
    const searchQb = () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it('matches accent-folded full text OR the folded substring', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      const [predicate, parameters] = qb.where.mock.calls[0] as [
        string,
        Record<string, string>,
      ];
      expect(predicate).toContain('websearch_to_tsquery');
      // Accent folding on both sides, so "sao" reaches "São".
      expect(predicate).toContain('translate(lower(');
      // The substring branch survives, so "trans" still finds "transfeminine".
      expect(predicate).toContain('LIKE');
      expect(parameters.searchTerm).toBe('sao');
      expect(parameters.searchPattern).toBe('%sao%');
    });

    it('escapes LIKE metacharacters in the substring branch', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', '100% cotton', 6);

      const [, parameters] = qb.where.mock.calls[0] as [
        string,
        Record<string, string>,
      ];
      expect(parameters.searchPattern).toBe('%100\\% cotton%');
    });

    it('ranks by relevance before recency', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('ts_rank'),
        'search_rank',
      );
      expect(qb.orderBy).toHaveBeenCalledWith('search_rank', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('t.last_activity_at', 'DESC');
    });

    it('keeps the block/mute filter on the thread author', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"t"."author_id"',
      );
    });

    it('keeps the Private-community gate', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      const communityCall = qb.andWhere.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('community_members'),
      );
      expect(communityCall).toBeDefined();
      expect(communityCall?.[1]).toEqual({
        privateTier: AccessTier.Private,
        viewerId: 'viewer-1',
      });
    });

    it('pages with a flat limit/offset', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 11, 20);

      expect(qb.limit).toHaveBeenCalledWith(11);
      expect(qb.offset).toHaveBeenCalledWith(20);
    });

    it('defaults the offset to zero', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      expect(qb.offset).toHaveBeenCalledWith(0);
    });
  });
});
