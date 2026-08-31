import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { decodeCursor, encodeCursor } from '../common/cursor-pagination';
import {
  CommunityMember,
  CommunityNotificationLevel,
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
  EventVenueConfirmation,
  EventVisibility,
} from '../events/entities/event.entity';
import { emptyAccessibilityAnswers } from '../listings/listing-accessibility';
import { ConnectionsService } from '../connections/connections.service';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { FeedInteractionsService } from './feed-interactions.service';
import { FeedMuteService } from './feed-mute.service';
import { decodeRankedCursor } from './feed-ranked-cursor';
import { FeedItem } from './feed-response';
import { FeedService } from './feed.service';

// A chainable query-builder stub whose terminal `getMany()` resolves to a
// configurable row list — mirrors `forum-threads.service.spec.ts`'s `qbStub`
// (itself adapted from `moderation.service.spec.ts`), extended with `where`
// since the "gathering" source also filters on status/visibility before the
// cursor predicate.
//
// Typed (rather than `Record<string, jest.Mock>`) for two reasons: a named
// property isn't subject to `noUncheckedIndexedAccess` the way an index
// signature is (that's what was making `qb.andWhere` read as "possibly
// undefined"), and giving each mock's call-argument tuple a real type (not
// `any`) lets `.mock.calls`/`toHaveBeenCalledWith` assertions narrow safely
// instead of tripping `no-unsafe-*`.
interface QbStub {
  where: jest.Mock<QbStub, unknown[]>;
  andWhere: jest.Mock<QbStub, unknown[]>;
  innerJoin: jest.Mock<QbStub, unknown[]>;
  orderBy: jest.Mock<QbStub, unknown[]>;
  addOrderBy: jest.Mock<QbStub, unknown[]>;
  take: jest.Mock<QbStub, unknown[]>;
  getMany: jest.Mock<Promise<unknown[]>, []>;
}

function qbStub(rows: unknown[] = []): QbStub {
  const qb: QbStub = {
    where: jest.fn<QbStub, unknown[]>(),
    andWhere: jest.fn<QbStub, unknown[]>(),
    innerJoin: jest.fn<QbStub, unknown[]>(),
    orderBy: jest.fn<QbStub, unknown[]>(),
    addOrderBy: jest.fn<QbStub, unknown[]>(),
    take: jest.fn<QbStub, unknown[]>(),
    getMany: jest.fn<Promise<unknown[]>, []>(),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.innerJoin.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);
  qb.getMany.mockResolvedValue(rows);
  return qb;
}

const t = (iso: string) => new Date(iso);

// Merges a COMPLETE entity default (typed as the entity itself, so TS
// rejects a default object missing a field the entity declares) with a
// caller's overrides. This is what actually catches a missing optional-vs-
// nullable field at compile time: spreading `Partial<T>` overrides directly
// over an incomplete literal silently widens any field the literal omitted
// to `T[K] | undefined`, which then fails the `CommunityPost`/`Community`/
// `CommunityMember` assignability check on properties typed `X | null`
// (never `X | null | undefined`) — see the `deletedById`/`frozenReason`/
// `notificationLevel` columns below.
function withOverrides<T>(defaults: T, overrides: Partial<T> = {}): T {
  return { ...defaults, ...overrides };
}

const communityPostDefaults: CommunityPost = {
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
  deletedById: null,
};

const basePost = (overrides: Partial<CommunityPost> = {}): CommunityPost =>
  withOverrides(communityPostDefaults, overrides);

const baseThread = (overrides: Partial<ForumThread> = {}): ForumThread => ({
  id: 'thread-1',
  slug: 'hello-world',
  title: 'Hello world',
  authorId: 'author-2',
  category: 'general',
  communityId: null,
  isPinned: false,
  pinnedAt: null,
  isLocked: false,
  lockReason: null,
  isOfficial: false,
  acceptedPostId: null,
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
  address: null,
  arrivalNotes: null,
  neighbourhood: null,
  language: null,
  eventType: null,
  accessibilityAnswers: emptyAccessibilityAnswers(),
  accessibilityNote: '',
  cost: null,
  listingId: null,
  venueConfirmation: EventVenueConfirmation.Pending,
  venueConfirmedAt: null,
  venueOwnerNotifiedAt: null,
  venueDetachedListingId: null,
  venueDetachedAt: null,
  communityId: null,
  isOnline: false,
  onlineUrl: null,
  capacity: null,
  nearlyFullNotifiedAt: null,
  visibility: EventVisibility.Public,
  status: EventStatus.Published,
  coverImageUrl: null,
  reminderSentAt: null,
  allowWaitlist: true,
  showAttendeeCount: true,
  seriesId: null,
  seriesIndex: null,
  createdAt: t('2026-07-08T00:00:00.000Z'),
  updatedAt: t('2026-07-08T00:00:00.000Z'),
  ...overrides,
});

const communityDefaults: Community = {
  id: 'community-1',
  slug: 'trans-nb-network',
  name: 'Trans & Non-Binary Network',
  purpose: 'purpose',
  type: CommunityType.Social,
  whoFor: 'who',
  tagline: 'tagline',
  accessTier: AccessTier.Public,
  rosterVisible: true,
  requiresSecondVouch: false,
  autoFreezeOnReports: false,
  features: [],
  rules: [],
  tags: [],
  coverImageUrl: null,
  ownerId: 'owner-1',
  ref: 'ref-1',
  createdAt: t('2026-01-01T00:00:00.000Z'),
  updatedAt: t('2026-01-01T00:00:00.000Z'),
  archivedAt: null,
  frozenAt: null,
  frozenReason: null,
  isFeatured: false,
  needsOwnerReviewAt: null,
  rulesVersion: 1,
  welcomeMessage: null,
  avatarImageUrl: null,
  city: null,
  area: null,
  isOnline: false,
  languages: [],
  activeThisWeek: 0,
  activityCountedAt: null,
  isPubliclyListed: false,
  frozenNote: null,
  frozenByUserId: null,
};

const baseCommunity = (overrides: Partial<Community> = {}): Community =>
  withOverrides(communityDefaults, overrides);

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
const communityMemberDefaults: CommunityMember = {
  id: 'membership-1',
  communityId: 'community-1',
  userId: 'member-1',
  role: RosterRole.Member,
  notificationLevel: CommunityNotificationLevel.Announcements,
  rulesAcceptedAt: null,
  rulesVersionAccepted: null,
  welcomeSeenAt: null,
  joinedAt: t('2026-07-10T00:00:00.000Z'),
};

const baseCommunityMember = (
  overrides: Partial<CommunityMember> = {},
): CommunityMember => withOverrides(communityMemberDefaults, overrides);

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
  let communityMembers: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let topicFollows: { find: jest.Mock };
  let memberPreferences: { findOne: jest.Mock };
  let blockFilter: { hiddenUserIds: jest.Mock };
  let connectionsService: { allAcceptedConnectionUserIds: jest.Mock };
  let feedInteractions: { forPosts: jest.Mock };
  let feedMutes: { mutedSources: jest.Mock };

  beforeEach(async () => {
    communityPosts = { createQueryBuilder: jest.fn(() => qbStub()) };
    communities = { find: jest.fn().mockResolvedValue([]) };
    forumThreads = { createQueryBuilder: jest.fn(() => qbStub()) };
    events = { createQueryBuilder: jest.fn(() => qbStub()) };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    // `find` backs the viewer's own memberships, one of the three explicit
    // graph facts the ranked "All" tab scores on (SOC-04). Empty by default,
    // so every pre-existing test sees the unchanged chronological order.
    communityMembers = {
      createQueryBuilder: jest.fn(() => qbStub()),
      find: jest.fn().mockResolvedValue([]),
    };
    topicFollows = { find: jest.fn().mockResolvedValue([]) };
    // PRD-10: no stored row, so the viewer has never opened the Interests
    // pane and every content-sensitivity filter is off. That is the real
    // default (`PreferencesService` synthesises it), and it keeps every
    // pre-existing test seeing the unchanged candidate queries.
    memberPreferences = { findOne: jest.fn().mockResolvedValue(null) };
    // `dropBlocked` now resolves the whole page's hidden authors in one batched
    // `hiddenUserIds(viewerId, authorIds)` call (union of blocked + muted),
    // returning a Set, rather than one `isBlockedEitherWay`/`isMutedBy` call
    // per author.
    blockFilter = {
      hiddenUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // DISC-2: `connections` tab support. Defaults to "no connections" so
    // every pre-existing test (none of which exercise the `connections`
    // tab) is unaffected — those tests never call this at all, since
    // `getFeed` only invokes it when `resolvedTab === 'connections'`.
    connectionsService = {
      allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    };
    // SOC-04: reaction/reply state for the page's community posts. Empty map
    // = "nobody has touched these posts", which every card falls back to.
    feedInteractions = { forPosts: jest.fn().mockResolvedValue(new Map()) };
    // SOC-18: nothing muted by default.
    feedMutes = {
      mutedSources: jest
        .fn()
        .mockResolvedValue({ communityIds: [], forumThreadIds: [] }),
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
        { provide: getRepositoryToken(TopicFollow), useValue: topicFollows },
        {
          provide: getRepositoryToken(MemberPreferences),
          useValue: memberPreferences,
        },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ConnectionsService, useValue: connectionsService },
        { provide: FeedInteractionsService, useValue: feedInteractions },
        { provide: FeedMuteService, useValue: feedMutes },
      ],
    }).compile();
    service = module.get(FeedService);
  });

  describe('moderator takedowns (BE-MSG-05)', () => {
    // The feed has no tombstone rendering, so a hidden/removed item would
    // surface with its real title, summary and deep link — the takedown has to
    // be enforced here exactly as it is on each source's own browse surface.
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    it('excludes taken-down community posts, forum threads and gatherings', async () => {
      const postQb = qbStub([basePost()]);
      const threadQb = qbStub([baseThread()]);
      const eventQb = qbStub([baseEvent()]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);
      events.createQueryBuilder.mockReturnValue(eventQb);
      communities.find.mockResolvedValue([baseCommunity()]);

      await service.getFeed('viewer-1', 'all', undefined);

      const postCall = predicateOf(postQb, 'content_moderation');
      expect(postCall?.[0]).toContain('"cp"."id"::text');
      expect(postCall?.[1]).toEqual({
        feedModerationSubjectTypes: ['post', 'reply'],
      });

      // A forum thread carries no takedown row of its own — its OP post does.
      const threadCall = predicateOf(threadQb, 'content_moderation');
      expect(threadCall?.[0]).toContain('"forum_post"');
      expect(threadCall?.[0]).toContain('"feed_op"."is_op" = true');
      expect(threadCall?.[1]).toEqual({
        feedModerationSubjectTypes: ['post', 'reply'],
      });

      const eventCall = predicateOf(eventQb, 'content_moderation');
      expect(eventCall?.[0]).toContain('"e"."id"::text');
      expect(eventCall?.[1]).toEqual({ feedModerationSubjectTypes: ['event'] });
    });
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

    // Fix round 2 (Task B): the `communities` tab's membership EXISTS check
    // above already proves the viewer is on that exact community's roster,
    // so a `community`-visibility gathering under it is provably theirs to
    // see — widen the base visibility set to admit it on this tab only.
    it('widens the gathering visibility set to include `community` on the "communities" tab', async () => {
      const qb = qbStub([]);
      events.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'communities', undefined);

      expect(qb.where).toHaveBeenCalledWith('e.status = :status', {
        status: EventStatus.Published,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'e.visibility IN (:...visibilities)',
        {
          visibilities: [
            EventVisibility.Public,
            EventVisibility.Members,
            EventVisibility.Community,
          ],
        },
      );
    });

    it('keeps the gathering visibility set to public/members ONLY on other tabs (e.g. "gatherings")', async () => {
      const qb = qbStub([]);
      events.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'gatherings', undefined);

      expect(qb.andWhere).toHaveBeenCalledWith(
        'e.visibility IN (:...visibilities)',
        {
          visibilities: [EventVisibility.Public, EventVisibility.Members],
        },
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

      // Split from a single nested
      // `expect.objectContaining({ ..., actor: expect.objectContaining(...) })`:
      // `@types/jest` types `objectContaining<E>(obj: E): any`, so the inner
      // call's `any` flowing into the outer literal's `actor:` property (an
      // object-literal property assignment, unlike the bare array element
      // below) trips `no-unsafe-assignment` — and casting that `any` away
      // trips `no-unnecessary-type-assertion` right back, since `any` is
      // already assignable to the cast target without one. Asserting
      // `actor.handle` directly checks the exact same thing.
      expect(items).toEqual([
        expect.objectContaining({
          id: 'membership-2',
          type: 'new_member',
          summary: 'Joined Trans & Non-Binary Network',
          link: '/profile/bilal-kaya',
        }),
      ]);
      expect(items[0]?.actor?.handle).toBe('bilal-kaya');
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
      // SOC-02: the card links to the post's own permalink, not the top of
      // the community timeline it happens to sit in.
      link: '/community/trans-nb-network/post/post-1',
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

  describe('"all" tab affinity ranking (SOC-04)', () => {
    // Only three inputs are allowed here, all of them explicit facts the
    // member created: they joined a community, they accepted a connection,
    // they followed a topic. There is no behavioural signal anywhere in this
    // path and there must never be one.
    const oldPostFromMyCommunity = basePost({
      id: 'post-mine',
      communityId: 'community-1',
      authorId: 'stranger',
      createdAt: t('2026-07-01T00:00:00.000Z'),
    });
    const newestStrangerThread = baseThread({
      id: 'thread-stranger',
      authorId: 'stranger',
      communityId: null,
      createdAt: t('2026-07-20T00:00:00.000Z'),
    });

    it('lifts an item from a community the viewer joined above a newer unrelated one', async () => {
      communityMembers.find.mockResolvedValue([
        baseCommunityMember({ userId: 'viewer-1', communityId: 'community-1' }),
      ]);
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([oldPostFromMyCommunity]),
      );
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([newestStrangerThread]),
      );
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data.map((item) => item.id)).toEqual([
        'post-mine',
        'thread-stranger',
      ]);
    });

    it('says WHY an item is there, naming the community the viewer is in', async () => {
      communityMembers.find.mockResolvedValue([
        baseCommunityMember({ userId: 'viewer-1', communityId: 'community-1' }),
      ]);
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([oldPostFromMyCommunity]),
      );
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data[0]).toMatchObject({
        reason: 'membership',
        reasonSubject: 'Trans & Non-Binary Network',
      });
    });

    it("scores an accepted connection's post, and names them as the reason", async () => {
      connectionsService.allAcceptedConnectionUserIds.mockResolvedValue([
        'author-1',
      ]);
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([
          basePost({
            id: 'post-from-friend',
            communityId: null,
            authorId: 'author-1',
            createdAt: t('2026-07-01T00:00:00.000Z'),
          }),
        ]),
      );
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([newestStrangerThread]),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data[0]).toMatchObject({
        id: 'post-from-friend',
        reason: 'connection',
        reasonSubject: 'Ava Lee',
      });
    });

    it("scores a followed topic off the thread's own tags", async () => {
      topicFollows.find.mockResolvedValue([
        { id: 'follow-1', userId: 'viewer-1', topicSlug: 'housing' },
      ]);
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([
          baseThread({
            id: 'thread-housing',
            tags: ['housing'],
            createdAt: t('2026-07-01T00:00:00.000Z'),
          }),
          baseThread({
            id: 'thread-other',
            tags: ['gardening'],
            createdAt: t('2026-07-20T00:00:00.000Z'),
          }),
        ]),
      );

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data[0]).toMatchObject({
        id: 'thread-housing',
        reason: 'topic',
        reasonSubject: 'housing',
      });
    });

    it('keeps a chronological lane, so unscored items still reach the page', async () => {
      // Four items the viewer has an explicit tie to, one they do not. With a
      // 3:1 weave the unrelated item must still appear on the first page
      // rather than being buried behind every scored item.
      communityMembers.find.mockResolvedValue([
        baseCommunityMember({ userId: 'viewer-1', communityId: 'community-1' }),
      ]);
      const mine = [1, 2, 3, 4].map((index) =>
        basePost({
          id: `post-mine-${index}`,
          communityId: 'community-1',
          createdAt: t(`2026-07-0${index}T00:00:00.000Z`),
        }),
      );
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(mine));
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([
          baseThread({
            id: 'thread-unrelated',
            communityId: null,
            createdAt: t('2026-06-01T00:00:00.000Z'),
          }),
        ]),
      );
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'all', undefined, 5);
      const ids = page.data.map((item) => item.id);

      // Three scored items, then the oldest unscored one, then the rest.
      expect(ids.indexOf('thread-unrelated')).toBe(3);
      expect(ids).toHaveLength(5);
    });

    it('leaves a member with no memberships, connections or follows in pure reverse-chronological order', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([
          basePost({
            id: 'post-old',
            createdAt: t('2026-07-01T00:00:00.000Z'),
          }),
        ]),
      );
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([
          baseThread({
            id: 'thread-new',
            createdAt: t('2026-07-20T00:00:00.000Z'),
          }),
        ]),
      );
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data.map((item) => item.id)).toEqual([
        'thread-new',
        'post-old',
      ]);
      expect(page.data[0]).toMatchObject({ reason: 'recent' });
    });

    it('pages through a ranked window by offset before advancing the window', async () => {
      const rows = [1, 2, 3, 4].map((index) =>
        basePost({
          id: `p${index}`,
          createdAt: t(`2026-07-2${index}T00:00:00.000Z`),
        }),
      );
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rows));
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'all', undefined, 2);

      expect(page.pageInfo.hasMore).toBe(true);
      // The window holds all four rows (limit 2 x 3 pages), so the next
      // request stays on the same window and just moves the offset.
      const decoded = decodeRankedCursor(page.pageInfo.nextCursor as string);
      expect(decoded).toEqual({ windowCursor: undefined, offset: 2 });
    });

    it('treats a plain pre-ranking cursor as the start of a window rather than rejecting it', async () => {
      const legacyCursor = encodeCursor({
        createdAt: t('2026-07-10T00:00:00.000Z'),
        id: 'post-9',
      });
      const qb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(qb);

      await service.getFeed('viewer-1', 'all', legacyCursor, 5);

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('< (:cursorCreatedAt, :cursorId)'),
        { cursorCreatedAt: t('2026-07-10T00:00:00.000Z'), cursorId: 'post-9' },
      );
    });
  });

  describe('inline card actions (SOC-04)', () => {
    it("carries reaction/reply counts and the viewer's own reaction on a community post", async () => {
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([basePost({ id: 'post-1' })]),
      );
      communities.find.mockResolvedValue([baseCommunity()]);
      feedInteractions.forPosts.mockResolvedValue(
        new Map([
          ['post-1', { reactionCount: 4, replyCount: 2, myReaction: 'like' }],
        ]),
      );

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      expect(feedInteractions.forPosts).toHaveBeenCalledWith(
        ['post-1'],
        'viewer-1',
      );
      expect(page.data[0]).toMatchObject({
        reactionCount: 4,
        replyCount: 2,
        myReaction: 'like',
      });
    });

    it('falls back to an empty interaction seed for a post nobody has touched', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([basePost({ id: 'post-1' })]),
      );
      communities.find.mockResolvedValue([baseCommunity()]);

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      expect(page.data[0]).toMatchObject({
        reactionCount: 0,
        replyCount: 0,
        myReaction: null,
      });
    });

    it("carries a forum thread's stored reply count", async () => {
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ replyCount: 7 })]),
      );

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      const thread = page.data.find((item) => item.type === 'forum_thread');
      expect(thread).toMatchObject({ replyCount: 7 });
    });
  });

  describe('feed source mutes (SOC-18)', () => {
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    it('excludes a muted community from posts, threads and gatherings, in-query', async () => {
      feedMutes.mutedSources.mockResolvedValue({
        communityIds: ['community-9'],
        forumThreadIds: [],
      });
      const postQb = qbStub([]);
      const threadQb = qbStub([]);
      const eventQb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);
      events.createQueryBuilder.mockReturnValue(eventQb);

      await service.getFeed('viewer-1', 'all', undefined);

      expect(predicateOf(postQb, 'mutedCommunityIds')?.[1]).toEqual({
        mutedCommunityIds: ['community-9'],
      });
      expect(predicateOf(threadQb, 't.community_id NOT IN')).toBeDefined();
      expect(predicateOf(eventQb, 'e.community_id NOT IN')).toBeDefined();
    });

    it('excludes a muted thread by id', async () => {
      feedMutes.mutedSources.mockResolvedValue({
        communityIds: [],
        forumThreadIds: ['thread-9'],
      });
      const threadQb = qbStub([]);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(predicateOf(threadQb, 't.id NOT IN')?.[1]).toEqual({
        mutedThreadIds: ['thread-9'],
      });
    });

    it('applies mutes on the scoped tabs too, so a muted room stays quiet everywhere', async () => {
      feedMutes.mutedSources.mockResolvedValue({
        communityIds: ['community-9'],
        forumThreadIds: [],
      });
      const postQb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);

      await service.getFeed('viewer-1', 'communities', undefined);

      expect(predicateOf(postQb, 'mutedCommunityIds')).toBeDefined();
    });

    it('emits no mute predicate at all when nothing is muted', async () => {
      const postQb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(predicateOf(postQb, 'mutedCommunityIds')).toBeUndefined();
    });
  });

  describe('content sensitivity (PRD-10)', () => {
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    // The default, and the one that has to stay cheap: a member who has never
    // opened the Interests pane has no preferences row, so no predicate is
    // emitted anywhere.
    it('emits nothing when the viewer has no preferences row', async () => {
      const postQb = qbStub([]);
      const threadQb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(predicateOf(postQb, 'feedExcludedCommunityTags')).toBeUndefined();
      expect(predicateOf(threadQb, 'excludedItemTags')).toBeUndefined();
    });

    it('emits nothing when every filter is switched off', async () => {
      memberPreferences.findOne.mockResolvedValue({
        hideDatingContent: false,
        hideMentalHealthContent: false,
        hideSexualityIdentityContent: false,
      });
      const postQb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(predicateOf(postQb, 'feedExcludedCommunityTags')).toBeUndefined();
    });

    it('excludes posts, threads and gatherings whose community carries an opted-out tag', async () => {
      memberPreferences.findOne.mockResolvedValue({
        hideDatingContent: false,
        hideMentalHealthContent: true,
        hideSexualityIdentityContent: false,
      });
      const postQb = qbStub([]);
      const threadQb = qbStub([]);
      const eventQb = qbStub([]);
      communityPosts.createQueryBuilder.mockReturnValue(postQb);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);
      events.createQueryBuilder.mockReturnValue(eventQb);

      await service.getFeed('viewer-1', 'all', undefined);

      for (const [qb, column] of [
        [postQb, 'cp.community_id'],
        [threadQb, 't.community_id'],
        [eventQb, 'e.community_id'],
      ] as const) {
        const call = predicateOf(qb, 'feedExcludedCommunityTags');
        expect(call?.[0]).toContain(column);
        // A flat/global item has no community to classify, so it stays.
        expect(call?.[0]).toContain('IS NULL OR NOT EXISTS');
        const params = call?.[1] as
          { feedExcludedCommunityTags: string[] } | undefined;
        expect(params?.feedExcludedCommunityTags).toContain('mental-health');
      }
    });

    // The branch that reaches a thread with no community at all: it carries
    // its own freeform tags, so it can be classified on its own.
    it('excludes forum threads by their own tags, aliases included', async () => {
      memberPreferences.findOne.mockResolvedValue({
        hideDatingContent: false,
        hideMentalHealthContent: true,
        hideSexualityIdentityContent: false,
      });
      const threadQb = qbStub([]);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      const call = predicateOf(threadQb, 'excludedItemTags');
      expect(call?.[0]).toBe('NOT (t.tags && :excludedItemTags)');
      const params = call?.[1] as { excludedItemTags: string[] } | undefined;
      expect(params?.excludedItemTags).toContain('mental-health');
      // The derived alias, so a thread the author tagged `#mentalhealth` is
      // caught by the same switch.
      expect(params?.excludedItemTags).toContain('mentalhealth');
    });

    // A new member is a person, and `profiles.tags` holds skills. There is
    // nothing here a content filter could honestly classify.
    it('never filters the new-member source', async () => {
      memberPreferences.findOne.mockResolvedValue({
        hideDatingContent: true,
        hideMentalHealthContent: true,
        hideSexualityIdentityContent: true,
      });
      const profileQb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(profileQb);

      await service.getFeed('viewer-1', 'people', undefined);

      expect(
        predicateOf(profileQb, 'feedExcludedCommunityTags'),
      ).toBeUndefined();
      expect(predicateOf(profileQb, 'excludedItemTags')).toBeUndefined();
    });
  });
});
