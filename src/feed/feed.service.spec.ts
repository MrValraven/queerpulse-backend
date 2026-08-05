import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { decodeCursor, encodeCursor } from '../common/cursor-pagination';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
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
import { FeedItem } from './feed-response';
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
  editedAt: null,
  deletedAt: null,
  ...overrides,
});

const baseThread = (overrides: Partial<ForumThread> = {}): ForumThread => ({
  id: 'thread-1',
  slug: 'hello-world',
  title: 'Hello world',
  authorId: 'author-2',
  category: 'general',
  communityId: null,
  isPinned: false,
  isLocked: false,
  replyCount: 3,
  lastActivityAt: t('2026-07-10T00:00:00.000Z'),
  createdAt: t('2026-07-09T00:00:00.000Z'),
  tags: [],
  opVoteCount: 0,
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
  listingId: null,
  communityId: null,
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
  archivedAt: null,
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

/** A `community_members` row as the `community_new_member` source itself
 * would return it (the candidate row IS the membership). */
const baseCommunityMember = (
  overrides: Partial<CommunityMember> = {},
): CommunityMember => ({
  id: 'membership-1',
  communityId: 'community-1',
  userId: 'member-1',
  role: RosterRole.Member,
  joinedAt: t('2026-07-10T00:00:00.000Z'),
  ...overrides,
});

/** Exercises `FeedService`'s private `fetchCandidates` directly for the
 * `community_new_member` source — same qb-stub mocking every other source's
 * test uses, just invoked one level down so the source's query-building can
 * be asserted independent of which tab(s) union it in
 * (`sourcesForTab`/`getFeed` cover that layer separately). */
interface FetchedCandidate {
  id: string;
  createdAt: Date;
  type: string;
  authorId: string;
  row: unknown;
}

function fetchCommunityNewMemberCandidates(
  serviceInstance: FeedService,
  viewerId: string,
  cursor: string | undefined,
  limit: number,
  membershipScoped = false,
): Promise<FetchedCandidate[]> {
  const withPrivateAccess = serviceInstance as unknown as {
    fetchCandidates: (
      kind: string,
      viewerId: string,
      cursor: string | undefined,
      limit: number,
      membershipScoped: boolean,
    ) => Promise<FetchedCandidate[]>;
  };
  return withPrivateAccess.fetchCandidates(
    'community_new_member',
    viewerId,
    cursor,
    limit,
    membershipScoped,
  );
}

describe('FeedService', () => {
  let service: FeedService;
  let communityPosts: { createQueryBuilder: jest.Mock };
  let communities: { find: jest.Mock };
  let forumThreads: { createQueryBuilder: jest.Mock };
  let events: { createQueryBuilder: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let blockFilter: { hiddenUserIds: jest.Mock };

  beforeEach(async () => {
    communityPosts = { createQueryBuilder: jest.fn(() => qbStub()) };
    communities = { find: jest.fn().mockResolvedValue([]) };
    forumThreads = { createQueryBuilder: jest.fn(() => qbStub()) };
    events = { createQueryBuilder: jest.fn(() => qbStub()) };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    communityMembers = { createQueryBuilder: jest.fn(() => qbStub()) };
    // `dropBlocked` now resolves the whole page's hidden authors in one batched
    // `hiddenUserIds(viewerId, authorIds)` call (union of blocked + muted),
    // returning a Set, rather than one `isBlockedEitherWay`/`isMutedBy` call
    // per author.
    blockFilter = {
      hiddenUserIds: jest.fn().mockResolvedValue(new Set<string>()),
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
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
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

    it('"communities" (Task 6) queries all four membership-scoped sources: community posts, gatherings, forum threads, and community_new_member', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub([basePost()]));
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ communityId: 'community-1' })]),
      );
      events.createQueryBuilder.mockReturnValue(
        qbStub([baseEvent({ communityId: 'community-1' })]),
      );
      communityMembers.createQueryBuilder.mockReturnValue(
        qbStub([baseCommunityMember()]),
      );

      const page = await service.getFeed('viewer-1', 'communities', undefined);

      expect(communityPosts.createQueryBuilder).toHaveBeenCalled();
      expect(forumThreads.createQueryBuilder).toHaveBeenCalled();
      expect(events.createQueryBuilder).toHaveBeenCalled();
      expect(communityMembers.createQueryBuilder).toHaveBeenCalled();
      // `community_new_member` candidates map to the FINAL `FeedItem.type`
      // `'new_member'` (see `communityNewMemberToFeedItem`'s docstring), not
      // the internal `'community_new_member'` discriminator.
      const types = page.data.map((i) => i.type).sort();
      expect(types).toEqual([
        'community_post',
        'forum_thread',
        'gathering',
        'new_member',
      ]);
    });

    it('"gatherings" only queries events', async () => {
      events.createQueryBuilder.mockReturnValue(qbStub([baseEvent()]));

      const page = await service.getFeed('viewer-1', 'gatherings', undefined);

      expect(events.createQueryBuilder).toHaveBeenCalled();
      expect(communityPosts.createQueryBuilder).not.toHaveBeenCalled();
      expect(forumThreads.createQueryBuilder).not.toHaveBeenCalled();
      expect(page.data).toHaveLength(1);
      expect(page.data[0]!.type).toBe('gathering');
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

  describe('"communities" tab membership scoping (Task 6)', () => {
    it('excludes a global/flat community post (community_id IS NULL) from the "communities" tab query', async () => {
      const qb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'communities', undefined);

      // The membership-only predicate requires a non-null community_id,
      // which alone rules a flat/global post out — unlike the access-tier
      // gate the other tabs use (that gate explicitly allows
      // `community_id IS NULL` through).
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('cp.community_id IS NOT NULL'),
        { viewerId: 'viewer-1' },
      );
    });

    it('excludes a community_post from a community the viewer is not a member of, replacing the access-tier gate entirely', async () => {
      const qb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'communities', undefined);

      // Membership-only predicate: a correlated EXISTS against
      // `community_members` keyed to the viewer — no access-tier fallback.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(
          /EXISTS \(\s*SELECT 1 FROM "community_members" "mem"\s*WHERE "mem"\."community_id" = cp\.community_id AND "mem"\."user_id" = :viewerId\)/,
        ),
        { viewerId: 'viewer-1' },
      );
      // The access-tier gate the other tabs use (private community OR
      // membership OR flat post) must NOT be applied on this tab.
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('access_tier'),
        expect.anything(),
      );
    });

    it('keeps the access-tier gate (not the membership-only predicate) for community_post on "posts"', async () => {
      // The highest-risk regression the membershipScoped if/else could cause:
      // a non-"communities" tab silently falling into the membership-only
      // branch and dropping every flat/global post + every post from a
      // public community the viewer hasn't joined.
      const qb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('access_tier'),
        { privateTier: AccessTier.Private, viewerId: 'viewer-1' },
      );
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('cp.community_id IS NOT NULL'),
        expect.anything(),
      );
    });

    it('applies the community_id + membership EXISTS predicate to the gathering source on the "communities" tab', async () => {
      const qb = qbStub([]);
      events.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'communities', undefined);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(
          /e\.community_id IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM "community_members" "mem"\s*WHERE "mem"\."community_id" = e\.community_id AND "mem"\."user_id" = :viewerId\)/,
        ),
        { viewerId: 'viewer-1' },
      );
    });

    it('does NOT apply the membership predicate to the gathering source on other tabs (e.g. "gatherings")', async () => {
      const qb = qbStub([]);
      events.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'gatherings', undefined);

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('e.community_id IS NOT NULL'),
        expect.anything(),
      );
    });

    it('applies the community_id + membership EXISTS predicate to the forum_thread source on the "communities" tab', async () => {
      const qb = qbStub([]);
      forumThreads.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'communities', undefined);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(
          /t\.community_id IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM "community_members" "mem"\s*WHERE "mem"\."community_id" = t\.community_id AND "mem"\."user_id" = :viewerId\)/,
        ),
        { viewerId: 'viewer-1' },
      );
    });

    it('does NOT apply the membership predicate to the forum_thread source on other tabs (e.g. "posts")', async () => {
      const qb = qbStub([]);
      forumThreads.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('t.community_id IS NOT NULL'),
        expect.anything(),
      );
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

      // The active-user filter is a correlated EXISTS (andWhere), not an
      // innerJoin: joining forces TypeORM's `.take()` down its distinct-
      // pagination path, which mangles the raw `date_trunc(...)` ORDER BY.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"u"."status" = :active'),
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
      blockFilter.hiddenUserIds.mockResolvedValue(new Set(['blocked-1']));

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
      blockFilter.hiddenUserIds.mockResolvedValue(new Set(['muted-1']));

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

  describe('community_new_member source (Task 5, not yet wired to a tab)', () => {
    it("returns members of the viewer's communities, excludes the viewer, ordered joined_at desc", async () => {
      const newer = baseCommunityMember({
        id: 'membership-2',
        userId: 'member-2',
        joinedAt: t('2026-07-12T00:00:00.000Z'),
      });
      const older = baseCommunityMember({
        id: 'membership-1',
        userId: 'member-1',
        joinedAt: t('2026-07-10T00:00:00.000Z'),
      });
      const qb = qbStub([newer, older]);
      communityMembers.createQueryBuilder.mockReturnValue(qb);

      const candidates = await fetchCommunityNewMemberCandidates(
        service,
        'viewer-1',
        undefined,
        21,
      );

      expect(communityMembers.createQueryBuilder).toHaveBeenCalledWith('m');
      // Excludes the viewer's own membership rows.
      expect(qb.where).toHaveBeenCalledWith('m.user_id != :viewerId', {
        viewerId: 'viewer-1',
      });
      // Restricted to memberships of communities the viewer also belongs to.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"self"."user_id" = :viewerId'),
        { viewerId: 'viewer-1' },
      );
      // Only active users.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"u"."status" = :active'),
        { active: UserStatus.Active },
      );
      // Ordered joined_at desc, id desc.
      expect(qb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('"m"."joined_at"'),
        'DESC',
      );
      expect(qb.addOrderBy).toHaveBeenCalledWith('m.id', 'DESC');

      expect(candidates.map((c) => c.id)).toEqual([
        'membership-2',
        'membership-1',
      ]);
      expect(candidates.every((c) => c.type === 'community_new_member')).toBe(
        true,
      );
      expect(candidates[0]).toMatchObject({
        authorId: 'member-2',
        createdAt: t('2026-07-12T00:00:00.000Z'),
      });
    });

    it('threads a supplied cursor into the underlying query as the keyset predicate', async () => {
      const cursor = encodeCursor({
        createdAt: t('2026-07-10T00:00:00.000Z'),
        id: 'membership-9',
      });
      const qb = qbStub([]);
      communityMembers.createQueryBuilder.mockReturnValue(qb);

      await fetchCommunityNewMemberCandidates(service, 'viewer-1', cursor, 21);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('< (:cursorCreatedAt, :cursorId)'),
        {
          cursorCreatedAt: t('2026-07-10T00:00:00.000Z'),
          cursorId: 'membership-9',
        },
      );
    });

    it('maps a community_new_member candidate to a "new_member"-typed FeedItem via toFeedItems', async () => {
      const membership = baseCommunityMember({
        id: 'membership-2',
        userId: 'member-2',
      });
      communityMembers.createQueryBuilder.mockReturnValue(qbStub([membership]));
      profiles.find.mockResolvedValue([
        baseMemberProfile({ userId: 'member-2', slug: 'bilal-kaya' }),
      ]);
      communities.find.mockResolvedValue([baseCommunity()]);

      const candidates = await fetchCommunityNewMemberCandidates(
        service,
        'viewer-1',
        undefined,
        21,
      );
      const items = await (
        service as unknown as {
          toFeedItems: (candidates: unknown[]) => Promise<FeedItem[]>;
        }
      ).toFeedItems(candidates);

      expect(items).toEqual([
        expect.objectContaining({
          id: 'membership-2',
          type: 'new_member',
          summary: 'Joined Trans & Non-Binary Network',
          link: '/profile/bilal-kaya',
          actor: expect.objectContaining({ handle: 'bilal-kaya' }),
        }),
      ]);
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
    blockFilter.hiddenUserIds.mockResolvedValue(new Set(['blocked-author']));

    const page = await service.getFeed('viewer-1', 'posts', undefined);

    // Both page authors are handed to the one batched call; the hidden one is
    // then filtered out of the result.
    expect(blockFilter.hiddenUserIds).toHaveBeenCalledWith(
      'viewer-1',
      expect.arrayContaining(['blocked-author', 'ok-author']),
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
    // A mute is folded into the same hidden-authors Set as a block.
    blockFilter.hiddenUserIds.mockResolvedValue(new Set(['muted-author']));

    const page = await service.getFeed('viewer-1', 'posts', undefined);

    expect(blockFilter.hiddenUserIds).toHaveBeenCalledWith(
      'viewer-1',
      expect.arrayContaining(['muted-author', 'ok-author']),
    );
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
      expect(decoded).toEqual({ createdAt: rows[1]!.createdAt, id: 'p2' });
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
    // Uses the "posts" tab rather than "communities": since Task 6, the
    // "communities" tab's real query excludes flat posts entirely (see the
    // `membershipScoped` describe block below) — this test is only about
    // `communityPostToFeedItem`'s mapping fallback for a flat post, which
    // "posts" (unaffected by membership scoping) still exercises.
    communityPosts.createQueryBuilder.mockReturnValue(
      qbStub([basePost({ communityId: null })]),
    );

    const page = await service.getFeed('viewer-1', 'posts', undefined);

    expect(page.data[0]).toMatchObject({
      title: 'Community feed',
      link: '/feed',
    });
    expect(communities.find).not.toHaveBeenCalled();
  });
});
