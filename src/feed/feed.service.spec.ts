import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { decodeCursor, encodeCursor } from '../common/cursor-pagination';
import {
  CommunityPost,
  PostKind,
} from '../communities/entities/community-post.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { FeedService } from './feed.service';

// A chainable query-builder stub whose terminal `getMany()` resolves to a
// configurable row list — mirrors `forum-threads.service.spec.ts`'s `qbStub`
// (itself adapted from `moderation.service.spec.ts`), extended with `where`
// since the "gathering" source also filters on status/visibility before the
// cursor predicate.
function qbStub(rows: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'where',
    'andWhere',
    'innerJoin',
    'orderBy',
    'addOrderBy',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const t = (iso: string) => new Date(iso);

const basePost = (overrides: Partial<CommunityPost> = {}): CommunityPost => ({
  id: 'post-1',
  communityId: 'community-1',
  authorId: 'author-1',
  body: 'Hello from the community post',
  image: null,
  kind: PostKind.Post,
  pinned: false,
  createdAt: t('2026-07-10T00:00:00.000Z'),
  ...overrides,
});

const baseThread = (overrides: Partial<ForumThread> = {}): ForumThread => ({
  id: 'thread-1',
  slug: 'hello-world',
  title: 'Hello world',
  authorId: 'author-2',
  category: 'general',
  isPinned: false,
  isLocked: false,
  replyCount: 3,
  lastActivityAt: t('2026-07-10T00:00:00.000Z'),
  createdAt: t('2026-07-09T00:00:00.000Z'),
  ...overrides,
});

const baseEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 'event-1',
  hostId: 'author-3',
  slug: 'queer-book-club',
  title: 'Queer Book Club',
  description: 'A cozy monthly meetup for queer readers.',
  startAt: t('2026-08-01T18:00:00.000Z'),
  endAt: null,
  timezone: 'Europe/Lisbon',
  venue: 'Livraria Trama',
  isOnline: false,
  onlineUrl: null,
  capacity: null,
  visibility: EventVisibility.Public,
  status: EventStatus.Published,
  coverImageUrl: null,
  reminderSentAt: null,
  createdAt: t('2026-07-08T00:00:00.000Z'),
  updatedAt: t('2026-07-08T00:00:00.000Z'),
  ...overrides,
});

const baseCommunity = (overrides: Partial<Community> = {}): Community => ({
  id: 'community-1',
  slug: 'trans-nb-network',
  name: 'Trans & Non-Binary Network',
  purpose: 'purpose',
  type: CommunityType.Social,
  whoFor: 'who',
  tagline: 'tagline',
  accessTier: AccessTier.Public,
  rosterVisible: true,
  features: [],
  rules: [],
  ownerId: 'owner-1',
  ref: 'ref-1',
  createdAt: t('2026-01-01T00:00:00.000Z'),
  updatedAt: t('2026-01-01T00:00:00.000Z'),
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

/** A profile row as the `new_member` source itself would return it (the
 * candidate row IS the member, not just a resolved author). */
const baseMemberProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    userId: 'member-1',
    slug: 'kai',
    firstName: 'Kai',
    lastName: 'Larsson',
    avatarUrl: null,
    tagline: 'Filmmaker new to Lisbon',
    bio: 'Longer bio text.',
    createdAt: t('2026-07-10T00:00:00.000Z'),
    ...overrides,
  }) as Profile;

describe('FeedService', () => {
  let service: FeedService;
  let communityPosts: { createQueryBuilder: jest.Mock };
  let communities: { find: jest.Mock };
  let forumThreads: { createQueryBuilder: jest.Mock };
  let events: { createQueryBuilder: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock; isMutedBy: jest.Mock };

  beforeEach(async () => {
    communityPosts = { createQueryBuilder: jest.fn(() => qbStub()) };
    communities = { find: jest.fn().mockResolvedValue([]) };
    forumThreads = { createQueryBuilder: jest.fn(() => qbStub()) };
    events = { createQueryBuilder: jest.fn(() => qbStub()) };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      isMutedBy: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedService,
        {
          provide: getRepositoryToken(CommunityPost),
          useValue: communityPosts,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(ForumThread), useValue: forumThreads },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(FeedService);
  });

  describe('tab -> source filtering', () => {
    it('"all" unions community posts, forum threads, and gatherings', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub([basePost()]));
      forumThreads.createQueryBuilder.mockReturnValue(qbStub([baseThread()]));
      events.createQueryBuilder.mockReturnValue(qbStub([baseEvent()]));
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(communityPosts.createQueryBuilder).toHaveBeenCalled();
      expect(forumThreads.createQueryBuilder).toHaveBeenCalled();
      expect(events.createQueryBuilder).toHaveBeenCalled();
      const types = page.data.map((i) => i.type).sort();
      expect(types).toEqual(['community_post', 'forum_thread', 'gathering']);
    });

    it('"communities" only queries community posts', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub([basePost()]));

      const page = await service.getFeed('viewer-1', 'communities', undefined);

      expect(communityPosts.createQueryBuilder).toHaveBeenCalled();
      expect(forumThreads.createQueryBuilder).not.toHaveBeenCalled();
      expect(events.createQueryBuilder).not.toHaveBeenCalled();
      expect(page.data).toHaveLength(1);
      expect(page.data[0].type).toBe('community_post');
    });

    it('"gatherings" only queries events', async () => {
      events.createQueryBuilder.mockReturnValue(qbStub([baseEvent()]));

      const page = await service.getFeed('viewer-1', 'gatherings', undefined);

      expect(events.createQueryBuilder).toHaveBeenCalled();
      expect(communityPosts.createQueryBuilder).not.toHaveBeenCalled();
      expect(forumThreads.createQueryBuilder).not.toHaveBeenCalled();
      expect(page.data).toHaveLength(1);
      expect(page.data[0].type).toBe('gathering');
    });

    it('"posts" unions community posts and forum threads, not gatherings', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub([basePost()]));
      forumThreads.createQueryBuilder.mockReturnValue(qbStub([baseThread()]));

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      expect(events.createQueryBuilder).not.toHaveBeenCalled();
      const types = page.data.map((i) => i.type).sort();
      expect(types).toEqual(['community_post', 'forum_thread']);
    });

    it('"people" only queries active member profiles, not the other sources', async () => {
      const page = await service.getFeed('viewer-1', 'people', undefined);

      expect(profiles.createQueryBuilder).toHaveBeenCalled();
      expect(communityPosts.createQueryBuilder).not.toHaveBeenCalled();
      expect(forumThreads.createQueryBuilder).not.toHaveBeenCalled();
      expect(events.createQueryBuilder).not.toHaveBeenCalled();
      expect(page).toEqual({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    });
  });

  describe('"people" tab / new_member items', () => {
    it('returns recently-joined members as new_member items, newest-first', async () => {
      const newer = baseMemberProfile({
        userId: 'member-2',
        slug: 'bilal-kaya',
        firstName: 'Bilal',
        lastName: 'Kaya',
        tagline: 'Just moved to Lisbon',
        createdAt: t('2026-07-12T00:00:00.000Z'),
      });
      const older = baseMemberProfile({
        createdAt: t('2026-07-10T00:00:00.000Z'),
      });
      profiles.createQueryBuilder.mockReturnValue(qbStub([newer, older]));
      profiles.find.mockResolvedValue([newer, older]);

      const page = await service.getFeed('viewer-1', 'people', undefined);

      expect(page.data.map((i) => i.id)).toEqual(['member-2', 'member-1']);
      expect(page.data[0]).toMatchObject({
        type: 'new_member',
        title: 'Bilal Kaya',
        summary: 'Just moved to Lisbon',
        link: '/profile/bilal-kaya',
        actor: {
          handle: 'bilal-kaya',
          displayName: 'Bilal Kaya',
          avatarUrl: null,
        },
      });
      expect(page.data.every((i) => i.type === 'new_member')).toBe(true);
    });

    it('only joins active users (filters on user status via the profiles query)', async () => {
      const qb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'people', undefined);

      expect(qb.innerJoin).toHaveBeenCalledWith(
        'p.user',
        'u',
        'u.status = :active',
        { active: UserStatus.Active },
      );
    });

    it('excludes the viewer\'s own profile from their "people" feed', async () => {
      // The exclusion happens in the SQL predicate the query builder is
      // asked to apply — this asserts the predicate is actually issued,
      // since the qb stub can't otherwise simulate DB-side filtering.
      const qb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-42', 'people', undefined);

      expect(qb.where).toHaveBeenCalledWith('p.user_id != :viewerId', {
        viewerId: 'viewer-42',
      });
    });

    it('drops new_member items whose member the viewer has blocked', async () => {
      const blocked = baseMemberProfile({
        userId: 'blocked-1',
        slug: 'blocked',
        createdAt: t('2026-07-12T00:00:00.000Z'),
      });
      const ok = baseMemberProfile({
        userId: 'ok-1',
        slug: 'ok',
        createdAt: t('2026-07-11T00:00:00.000Z'),
      });
      profiles.createQueryBuilder.mockReturnValue(qbStub([blocked, ok]));
      profiles.find.mockResolvedValue([blocked, ok]);
      blockFilter.isBlockedEitherWay.mockImplementation(
        (_viewer: string, authorId: string) => authorId === 'blocked-1',
      );

      const page = await service.getFeed('viewer-1', 'people', undefined);

      expect(page.data.map((i) => i.id)).toEqual(['ok-1']);
    });

    it('drops new_member items whose member the viewer has muted', async () => {
      const muted = baseMemberProfile({
        userId: 'muted-1',
        slug: 'muted',
        createdAt: t('2026-07-12T00:00:00.000Z'),
      });
      const ok = baseMemberProfile({
        userId: 'ok-1',
        slug: 'ok',
        createdAt: t('2026-07-11T00:00:00.000Z'),
      });
      profiles.createQueryBuilder.mockReturnValue(qbStub([muted, ok]));
      profiles.find.mockResolvedValue([muted, ok]);
      blockFilter.isMutedBy.mockImplementation(
        (_viewer: string, authorId: string) => authorId === 'muted-1',
      );

      const page = await service.getFeed('viewer-1', 'people', undefined);

      expect(page.data.map((i) => i.id)).toEqual(['ok-1']);
    });

    it('"all" includes new_member items alongside the other sources', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub([basePost()]));
      const member = baseMemberProfile();
      profiles.createQueryBuilder.mockReturnValue(qbStub([member]));
      profiles.find.mockResolvedValue([member]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      const types = page.data.map((i) => i.type).sort();
      expect(types).toEqual(['community_post', 'new_member']);
    });
  });

  it('merges across sources newest-first, tie-breaking by id', async () => {
    const oldest = basePost({
      id: 'post-old',
      createdAt: t('2026-07-01T00:00:00.000Z'),
    });
    const middle = baseThread({
      id: 'thread-mid',
      createdAt: t('2026-07-05T00:00:00.000Z'),
    });
    const newest = baseEvent({
      id: 'event-new',
      createdAt: t('2026-07-10T00:00:00.000Z'),
    });

    communityPosts.createQueryBuilder.mockReturnValue(qbStub([oldest]));
    forumThreads.createQueryBuilder.mockReturnValue(qbStub([middle]));
    events.createQueryBuilder.mockReturnValue(qbStub([newest]));

    const page = await service.getFeed('viewer-1', 'all', undefined);

    expect(page.data.map((i) => i.id)).toEqual([
      'event-new',
      'thread-mid',
      'post-old',
    ]);
  });

  it('drops items whose author is blocked either way relative to the viewer', async () => {
    const fromBlocked = basePost({
      id: 'post-blocked',
      authorId: 'blocked-author',
    });
    const fromOk = baseThread({
      id: 'thread-ok',
      authorId: 'ok-author',
      createdAt: t('2026-07-09T12:00:00.000Z'),
    });

    communityPosts.createQueryBuilder.mockReturnValue(qbStub([fromBlocked]));
    forumThreads.createQueryBuilder.mockReturnValue(qbStub([fromOk]));
    blockFilter.isBlockedEitherWay.mockImplementation(
      (_viewer: string, authorId: string) => authorId === 'blocked-author',
    );

    const page = await service.getFeed('viewer-1', 'posts', undefined);

    expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      'viewer-1',
      'blocked-author',
    );
    expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      'viewer-1',
      'ok-author',
    );
    expect(page.data.map((i) => i.id)).toEqual(['thread-ok']);
  });

  it('(I10) drops items whose author the viewer has muted, even when not blocked', async () => {
    const fromMuted = basePost({
      id: 'post-muted',
      authorId: 'muted-author',
    });
    const fromOk = baseThread({
      id: 'thread-ok',
      authorId: 'ok-author',
      createdAt: t('2026-07-09T12:00:00.000Z'),
    });

    communityPosts.createQueryBuilder.mockReturnValue(qbStub([fromMuted]));
    forumThreads.createQueryBuilder.mockReturnValue(qbStub([fromOk]));
    blockFilter.isMutedBy.mockImplementation(
      (_viewer: string, authorId: string) => authorId === 'muted-author',
    );

    const page = await service.getFeed('viewer-1', 'posts', undefined);

    expect(blockFilter.isMutedBy).toHaveBeenCalledWith(
      'viewer-1',
      'muted-author',
    );
    expect(blockFilter.isMutedBy).toHaveBeenCalledWith('viewer-1', 'ok-author');
    expect(page.data.map((i) => i.id)).toEqual(['thread-ok']);
  });

  describe('cursor / hasMore boundary', () => {
    it('reports hasMore + a nextCursor when more rows exist beyond the page', async () => {
      const rows = [
        basePost({ id: 'p1', createdAt: t('2026-07-10T00:00:03.000Z') }),
        basePost({ id: 'p2', createdAt: t('2026-07-10T00:00:02.000Z') }),
        basePost({ id: 'p3', createdAt: t('2026-07-10T00:00:01.000Z') }),
      ];
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rows));

      const page = await service.getFeed(
        'viewer-1',
        'communities',
        undefined,
        2,
      );

      expect(page.data.map((i) => i.id)).toEqual(['p1', 'p2']);
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).not.toBeNull();

      const decoded = decodeCursor(page.pageInfo.nextCursor as string);
      expect(decoded).toEqual({ createdAt: rows[1].createdAt, id: 'p2' });
    });

    it('reports hasMore=false + nextCursor=null when the page exactly exhausts the rows', async () => {
      const rows = [
        basePost({ id: 'p1', createdAt: t('2026-07-10T00:00:02.000Z') }),
        basePost({ id: 'p2', createdAt: t('2026-07-10T00:00:01.000Z') }),
      ];
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rows));

      const page = await service.getFeed(
        'viewer-1',
        'communities',
        undefined,
        2,
      );

      expect(page.data).toHaveLength(2);
      expect(page.pageInfo.hasMore).toBe(false);
      expect(page.pageInfo.nextCursor).toBeNull();
    });

    it('threads a supplied cursor into the underlying query as the keyset predicate', async () => {
      const cursor = encodeCursor({
        createdAt: t('2026-07-10T00:00:00.000Z'),
        id: 'post-9',
      });
      const qb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'communities', cursor, 5);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('< (:cursorCreatedAt, :cursorId)'),
        { cursorCreatedAt: t('2026-07-10T00:00:00.000Z'), cursorId: 'post-9' },
      );
    });
  });

  it('returns an empty page when every included source has no rows', async () => {
    const page = await service.getFeed('viewer-1', 'all', undefined);

    expect(page).toEqual({
      data: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
  });

  it('resolves author + (for scoped posts) community details in the mapped item', async () => {
    communityPosts.createQueryBuilder.mockReturnValue(
      qbStub([basePost({ communityId: 'community-1' })]),
    );
    communities.find.mockResolvedValue([baseCommunity()]);
    profiles.find.mockResolvedValue([baseProfile()]);

    const page = await service.getFeed('viewer-1', 'communities', undefined);

    expect(page.data[0]).toMatchObject({
      type: 'community_post',
      title: 'Trans & Non-Binary Network',
      link: '/community/trans-nb-network',
      actor: { handle: 'ava', displayName: 'Ava Lee', avatarUrl: null },
    });
  });

  it('falls back to a generic title/link for a flat (global) community post', async () => {
    communityPosts.createQueryBuilder.mockReturnValue(
      qbStub([basePost({ communityId: null })]),
    );

    const page = await service.getFeed('viewer-1', 'communities', undefined);

    expect(page.data[0]).toMatchObject({
      title: 'Community feed',
      link: '/feed',
    });
    expect(communities.find).not.toHaveBeenCalled();
  });
});
