import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { TopicPostLinkService } from '../content/topic-post-link.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
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
  // `paginateTop` probes how many threads fall inside the recency window on a
  // clone of the fully-filtered builder (PRD-161), so the stub has to answer
  // both. `clone` returns the SAME stub: the assertions care about which
  // predicates were folded on, and one shared call log is easier to read than
  // two.
  clone: jest.Mock<QbStub, unknown[]>;
  getCount: jest.Mock<Promise<number>, []>;
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
    clone: jest.fn<QbStub, unknown[]>(),
    getCount: jest.fn<Promise<number>, []>(),
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
  qb.clone.mockReturnValue(qb);
  // Default: too few threads inside the `top` window, so `paginateTop` falls
  // through to the unwindowed set. Tests that want the window opt in.
  qb.getCount.mockResolvedValue(0);
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
  deletedAt: null,
  deletedById: null,
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
    manager: { createQueryBuilder: jest.Mock; query: jest.Mock };
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
  // PRD-167 — the thread card's `excerpt` has to know whether a moderator took
  // the OP down. Default: nothing moderated.
  let contentModeration: { statesForAnyType: jest.Mock };
  // BE-COM-19's staff audit trail, which `deleteThread` appends to when a
  // moderator takes down a thread they did not write (PRD-160).
  let modAudit: { writeAuditLog: jest.Mock };
  // SOC-13 following plus the C7/PRD-170 watermark. Hoisted so the read-watermark
  // tests can assert that opening a thread stamps but never subscribes.
  let subscriptions: {
    isSubscribed: jest.Mock;
    subscribedThreadIds: jest.Mock;
    subscribe: jest.Mock;
    subscribeQuietly: jest.Mock;
    unsubscribe: jest.Mock;
    markRead: jest.Mock;
  };
  // The `EntityManager` `dataSource.transaction` hands its callback — hoisted
  // so `deleteThread`'s two `update` calls can be asserted on.
  let manager: {
    increment: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    getRepository: jest.Mock;
  };

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
        // C7/PRD-170 — `unreadReplyCountsByThread` is one grouped raw query per
        // page. Default: no watermark for anybody, so every card comes back
        // with `unreadReplyCount: null`.
        query: jest.fn().mockResolvedValue([]),
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
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map<string, unknown>()),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };

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
    manager = {
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

    subscriptions = {
      isSubscribed: jest.fn().mockResolvedValue(false),
      subscribedThreadIds: jest.fn().mockResolvedValue(new Set()),
      subscribe: jest.fn(),
      subscribeQuietly: jest.fn(),
      unsubscribe: jest.fn(),
      // C7/PRD-170 — the read watermark, written by
      // `POST /forum/threads/:slug/read`.
      markRead: jest.fn(),
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
        { provide: ModAuditService, useValue: modAudit },
        {
          provide: ContentModerationService,
          useValue: contentModeration,
        },
        // SOC-13 thread following — the service resolves `isSubscribed` on
        // every read path and auto-subscribes an author on create.
        {
          provide: ForumSubscriptionsService,
          useValue: subscriptions,
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
    // PRD-161 — `top` used to order `op_vote_count DESC, id DESC` with no
    // second sort key and no time bound, so every zero-vote thread (nearly all
    // of them on a young forum) came back in uuid order.
    it('orders by op_vote_count, then recency, then id for sort=top', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'top');

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."op_vote_count"', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith(
        '"t"."last_activity_at"',
        'DESC',
      );
      expect(qb.addOrderBy).toHaveBeenCalledWith('t.id', 'DESC');
    });

    it('drops the top window when too few threads fall inside it', async () => {
      const qb = qbStub([baseThread()]);
      qb.getCount.mockResolvedValue(3);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'top');

      // The probe ran against a clone carrying every filter already folded on,
      // and its answer was "not enough", so the real query is unwindowed.
      expect(qb.clone).toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        't.created_at >= :topWindowStart',
        expect.anything(),
      );
    });

    it('applies the 30-day top window once enough threads fall inside it', async () => {
      const qb = qbStub([baseThread()]);
      qb.getCount.mockResolvedValue(200);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'top');

      const windowCall = qb.andWhere.mock.calls.find(
        ([sql]) => sql === 't.created_at >= :topWindowStart',
      );
      expect(windowCall).toBeDefined();
      const params = windowCall?.[1] as { topWindowStart: Date };
      const daysBack =
        (Date.now() - params.topWindowStart.getTime()) / (24 * 60 * 60 * 1000);
      expect(daysBack).toBeGreaterThan(29.9);
      expect(daysBack).toBeLessThan(30.1);
    });

    it('seeks past the cursor on all three top columns as one tuple', async () => {
      const first = qbStub([baseThread({ id: 'a', opVoteCount: 4 })]);
      // `limit + 1` rows come back so the page reports `hasMore` and mints a
      // cursor.
      first.getMany.mockResolvedValue([
        baseThread({ id: 'a', opVoteCount: 4 }),
        baseThread({ id: 'b', opVoteCount: 4 }),
      ]);
      threads.createQueryBuilder.mockReturnValue(first);

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        1,
        'top',
      );
      expect(page.pageInfo.hasMore).toBe(true);
      const cursor = page.pageInfo.nextCursor ?? '';
      expect(cursor).not.toBe('');

      const second = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(second);
      await service.list('viewer-1', undefined, cursor, 1, 'top');

      const seek = second.andWhere.mock.calls.find(([sql]) =>
        String(sql).includes('("t"."op_vote_count", "t"."last_activity_at"'),
      );
      expect(seek).toBeDefined();
      expect(seek?.[1]).toEqual(
        expect.objectContaining({ topVoteCount: 4, topId: 'a' }),
      );
    });

    it('inherits the window decision from the cursor instead of re-counting', async () => {
      const first = qbStub([]);
      first.getCount.mockResolvedValue(200);
      first.getMany.mockResolvedValue([
        baseThread({ id: 'a' }),
        baseThread({ id: 'b' }),
      ]);
      threads.createQueryBuilder.mockReturnValue(first);
      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        1,
        'top',
      );

      // The forum has gone quiet by page two: a fresh count would now say
      // "unwindowed" and silently change what the scroll is paging through.
      const second = qbStub([]);
      second.getCount.mockResolvedValue(0);
      threads.createQueryBuilder.mockReturnValue(second);
      await service.list(
        'viewer-1',
        undefined,
        page.pageInfo.nextCursor ?? undefined,
        1,
        'top',
      );

      expect(second.getCount).not.toHaveBeenCalled();
      expect(second.andWhere).toHaveBeenCalledWith(
        't.created_at >= :topWindowStart',
        expect.anything(),
      );
    });

    it('orders by last_activity_at DESC for sort=active', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'active');

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."last_activity_at"', 'DESC');
    });

    it('narrows to unresolved threads on the created_at keyset for sort=unanswered', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        'unanswered',
      );

      // SOC-13: "unanswered" means no ACCEPTED answer, so a question with
      // forty replies and no resolution still counts as unanswered.
      expect(qb.andWhere).toHaveBeenCalledWith('t.accepted_post_id IS NULL');
      // Still the default createdAt keyset (raw ms-precision column), not a
      // swapped leading column.
      expect(qb.orderBy).toHaveBeenCalledWith('"t"."created_at"', 'DESC');
    });

    it('uses the default created_at keyset for sort=new', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'new');

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."created_at"', 'DESC');
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        't.accepted_post_id IS NULL',
      );
    });

    // PRD-161 — an omitted sort used to mean `new` on the server while the
    // frontend defaulted to `top`, so an unparameterised call answered a
    // question nobody asked. It now means `active`, and the frontend matches.
    it('defaults to the active keyset when no sort is given', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      expect(qb.orderBy).toHaveBeenCalledWith('"t"."last_activity_at"', 'DESC');
      expect(qb.orderBy).not.toHaveBeenCalledWith('"t"."created_at"', 'DESC');
    });
  });

  describe('list q/tag filters', () => {
    // C9/PRD-164 — `q` used to be `title ILIKE` alone, so the forum's own search
    // box returned nothing for a question that was answered in a reply.
    it('matches the title OR any visible reply body for q', async () => {
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

      const searchCall = qb.andWhere.mock.calls.find(([sql]) =>
        String(sql).includes('t.title ILIKE :forumSearchPattern'),
      );
      expect(searchCall).toBeDefined();
      const sql = String(searchCall?.[0]);
      // A correlated EXISTS, never a join: a join would multiply the thread row
      // once per matching reply and break the keyset page.
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('"__search_post"."thread_id" = t.id');
      expect(sql).toContain('"__search_post"."body" ILIKE :forumSearchPattern');
      // A tombstoned post keeps its body only so it can be restored, and a
      // moderated one was deliberately taken down. Either matching would turn
      // this filter into an oracle for what a removed post said.
      expect(sql).toContain('"__search_post"."deleted_at" IS NULL');
      expect(sql).toContain('content_moderation');
      expect(searchCall?.[1]).toEqual(
        expect.objectContaining({ forumSearchPattern: '%rent%' }),
      );
    });

    it('escapes LIKE metacharacters once, for both branches', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '50%_off',
      );

      const searchCall = qb.andWhere.mock.calls.find(([sql]) =>
        String(sql).includes('t.title ILIKE :forumSearchPattern'),
      );
      expect(searchCall?.[1]).toEqual(
        expect.objectContaining({
          forumSearchPattern: String.raw`%50\%\_off%`,
        }),
      );
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

      expect(
        qb.andWhere.mock.calls.some(([sql]) =>
          String(sql).includes('ILIKE :forumSearchPattern'),
        ),
      ).toBe(false);
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

      // Identical narrowing to `list()` — that shared helper is the whole point:
      // a badge counting threads the list will not draw promises a row that
      // never arrives (C9/PRD-164).
      const searchCall = qb.andWhere.mock.calls.find(([sql]) =>
        String(sql).includes('t.title ILIKE :forumSearchPattern'),
      );
      expect(searchCall).toBeDefined();
      expect(String(searchCall?.[0])).toContain(
        '"__search_post"."body" ILIKE :forumSearchPattern',
      );
      expect(searchCall?.[1]).toEqual(
        expect.objectContaining({ forumSearchPattern: '%rent%' }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(':tag = ANY(t.tags)', {
        tag: 'housing',
      });
    });

    // PRD-160 — the badges and the list must admit the same set.
    it('excludes withdrawn threads for a member and keeps them for staff', async () => {
      const memberQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(memberQb);
      await service.counts('viewer-1', undefined, undefined);
      expect(memberQb.andWhere).toHaveBeenCalledWith('t.deleted_at IS NULL');

      const staffQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(staffQb);
      await service.counts('mod-1', undefined, undefined, true);
      expect(staffQb.andWhere).not.toHaveBeenCalledWith('t.deleted_at IS NULL');
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
      // Clearing the mark never looks a post up by id. The one read left is
      // the response's opening-post hydration, which every read of a thread
      // does regardless.
      const postLookupCalls = posts.findOne.mock.calls as [
        { where?: { id?: string } },
      ][];
      const hasLookupById = postLookupCalls.some(
        ([options]) => options?.where?.id !== undefined,
      );
      expect(hasLookupById).toBe(false);
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

    it('keeps withdrawn threads out of global search', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      expect(qb.andWhere).toHaveBeenCalledWith('t.deleted_at IS NULL');
    });
  });

  // PRD-160 — the thread's own delete, distinct from the OP post's tombstone.
  describe('deleteThread', () => {
    const authored = () =>
      baseThread({ authorId: 'member-1', slug: 'hello-world' });

    it('lets the author withdraw their own thread and tombstones the OP', async () => {
      threads.findOne.mockResolvedValue(authored());

      const dto = await service.deleteThread('hello-world', member);

      expect(dto.isDeleted).toBe(true);
      const threadUpdate = manager.update.mock.calls.find(
        ([entity]) => entity === ForumThread,
      ) as [unknown, unknown, { deletedAt: Date; deletedById: string }];
      expect(threadUpdate[2].deletedAt).toBeInstanceOf(Date);
      expect(threadUpdate[2].deletedById).toBe('member-1');

      const postUpdate = manager.update.mock.calls.find(
        ([entity]) => entity === ForumPost,
      ) as [
        unknown,
        { threadId: string; isOp: boolean; deletedAt: unknown },
        { deletedAt: Date; deletedById: string },
      ];
      // The OP only, never the replies: they are other people's words.
      expect(postUpdate[1]).toEqual(
        expect.objectContaining({ threadId: 'thread-1', isOp: true }),
      );
      // An OP a moderator already took down keeps its own actor, so the author
      // cannot lift a staff takedown by deleting and restoring their thread.
      expect(postUpdate[1].deletedAt).toBeDefined();
      expect(postUpdate[2].deletedById).toBe('member-1');
    });

    it('lets a moderator take down a thread they did not write, and audits it', async () => {
      threads.findOne.mockResolvedValue(baseThread({ authorId: 'someone' }));

      await service.deleteThread('hello-world', moderator);

      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'mod-1',
        'thread_deleted',
        undefined,
        expect.stringContaining('hello-world'),
      );
    });

    it('writes no audit row when an author withdraws their own thread', async () => {
      threads.findOne.mockResolvedValue(authored());

      await service.deleteThread('hello-world', member);

      // Members changing their minds is not a moderation trail.
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('403s a stranger on a live thread', async () => {
      threads.findOne.mockResolvedValue(baseThread({ authorId: 'someone' }));

      await expect(
        service.deleteThread('hello-world', member),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('404s a stranger on an already-withdrawn thread', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ authorId: 'someone', deletedAt: new Date() }),
      );

      // A 403 here would confirm the thread exists and was withdrawn, which is
      // exactly the fact the delete retracted.
      await expect(
        service.deleteThread('hello-world', member),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent: a second delete writes nothing', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ authorId: 'member-1', deletedAt: new Date() }),
      );

      const dto = await service.deleteThread('hello-world', member);

      expect(dto.isDeleted).toBe(true);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('withdrawn threads in the read paths (PRD-160)', () => {
    it('404s a member reading a withdrawn thread by slug', async () => {
      threads.findOne.mockResolvedValue(baseThread({ deletedAt: new Date() }));

      await expect(
        service.getBySlug('hello-world', 'viewer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still serves it to a moderator, flagged', async () => {
      threads.findOne.mockResolvedValue(baseThread({ deletedAt: new Date() }));

      const dto = await service.getBySlug('hello-world', 'mod-1', true);

      expect(dto.isDeleted).toBe(true);
    });

    it('filters the browse list for a member and not for staff', async () => {
      const memberQb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(memberQb);
      await service.list('viewer-1', undefined, undefined, undefined);
      expect(memberQb.andWhere).toHaveBeenCalledWith('t.deleted_at IS NULL');

      const staffQb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(staffQb);
      await service.list(
        'mod-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(staffQb.andWhere).not.toHaveBeenCalledWith('t.deleted_at IS NULL');
    });

    it('filters the pinned bucket for a member', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.listPinned('viewer-1', undefined, false);

      expect(qb.andWhere).toHaveBeenCalledWith('t.deleted_at IS NULL');
    });

    it('does not let a withdrawn thread hold a pin slot', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await service.setPinned('hello-world', moderator, true);

      expect(threads.count).toHaveBeenCalledWith({
        where: { isPinned: true, deletedAt: IsNull() },
      });
    });
  });

  // C8/PRD-163 — a mis-filed thread used to be mis-filed forever.
  describe('category move', () => {
    it('lets the author move their own thread inside the 24-hour window', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ authorId: 'member-1', createdAt: new Date() }),
      );

      const dto = await service.updateThread(
        'hello-world',
        member,
        undefined,
        undefined,
        'health',
      );

      expect(dto.category).toBe('health');
    });

    it('refuses the author once the window has closed', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({
          authorId: 'member-1',
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        }),
      );

      await expect(
        service.updateThread(
          'hello-world',
          member,
          undefined,
          undefined,
          'health',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a moderator re-file an old thread they did not write', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({
          authorId: 'someone',
          createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        }),
      );

      const dto = await service.updateThread(
        'hello-world',
        moderator,
        undefined,
        undefined,
        'health',
      );

      expect(dto.category).toBe('health');
    });

    it('refuses a category move from a stranger', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ authorId: 'someone', createdAt: new Date() }),
      );

      await expect(
        service.updateThread(
          'hello-world',
          member,
          undefined,
          undefined,
          'health',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('writes no edit revision for a category-only move', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ authorId: 'someone', createdAt: new Date() }),
      );
      posts.findOne.mockResolvedValue({
        id: 'post-1',
        body: 'body',
        editedAt: null,
      });

      await service.updateThread(
        'hello-world',
        moderator,
        undefined,
        undefined,
        'health',
      );

      // Re-filing a thread changed nothing about the post's words, so an
      // "edited" mark would be false on its face.
      expect(edits.create).not.toHaveBeenCalled();
    });

    it('400s a patch that sends nothing at all', async () => {
      threads.findOne.mockResolvedValue(baseThread({ authorId: 'member-1' }));

      await expect(
        service.updateThread('hello-world', member),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // --- C7 / PRD-170: the read watermark ------------------------------------
  // The forum had no unread marker of any kind. Someone following five threads
  // got notifications but, on the list itself, could not see which threads had
  // moved and had to reopen each one to find out.
  describe('read watermark', () => {
    it('stamps a watermark WITHOUT following the thread', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await expect(service.markRead('hello-world', member)).resolves.toEqual({
        ok: true,
      });

      expect(subscriptions.markRead).toHaveBeenCalledWith(
        'thread-1',
        'member-1',
      );
      // Opening a thread must never sign anybody up for a notification per
      // reply for the rest of its life.
      expect(subscriptions.subscribe).not.toHaveBeenCalled();
    });

    it('refuses to stamp a watermark on a thread the member cannot read', async () => {
      threads.findOne.mockResolvedValue(baseThread({ deletedAt: new Date() }));

      await expect(
        service.markRead('hello-world', member),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('counts unread replies for the page in ONE query, never one per row', async () => {
      const qb = qbStub([baseThread(), baseThread({ id: 'thread-2' })]);
      threads.createQueryBuilder.mockReturnValue(qb);
      threads.manager.query.mockResolvedValue([
        { thread_id: 'thread-2', unread_count: '4' },
      ]);

      const page = await service.list(
        'member-1',
        undefined,
        undefined,
        undefined,
      );

      expect(threads.manager.query).toHaveBeenCalledTimes(1);
      // Absent from the result = no watermark, which is `null` (no unread
      // information), never 0.
      expect(page.data[0]?.unreadReplyCount).toBeNull();
      expect(page.data[1]?.unreadReplyCount).toBe(4);
    });

    it('never counts against a thread the viewer has never opened', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list(
        'member-1',
        undefined,
        undefined,
        undefined,
      );

      // The SQL only joins rows whose `last_read_at IS NOT NULL`, so a
      // never-opened thread produces no group and reads as null here.
      const [sql] = threads.manager.query.mock.calls[0] as [string];
      expect(sql).toContain('"watermark"."last_read_at" IS NOT NULL');
      expect(page.data[0]?.unreadReplyCount).toBeNull();
    });

    it('excludes the viewer own replies, tombstones, and blocked or muted authors', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('member-1', undefined, undefined, undefined);

      const [sql] = threads.manager.query.mock.calls[0] as [string];
      // Each exclusion exists so the badge cannot promise a reply the thread
      // page will not draw.
      expect(sql).toContain('"p"."author_id" <> $1');
      expect(sql).toContain('"p"."deleted_at" IS NULL');
      expect(sql).toContain('"p"."is_op" = false');
      expect(sql).toContain('"__unread_block"');
      expect(sql).toContain('"__unread_mute"');
    });
  });
});
