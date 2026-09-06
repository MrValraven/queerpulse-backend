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
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
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
  /** PRD-107: the magazine source projects its columns before filtering, so
   *  the shared stub has to be chainable through `select` too. */
  select: jest.Mock<QbStub, unknown[]>;
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
    select: jest.fn<QbStub, unknown[]>(),
    where: jest.fn<QbStub, unknown[]>(),
    andWhere: jest.fn<QbStub, unknown[]>(),
    innerJoin: jest.fn<QbStub, unknown[]>(),
    orderBy: jest.fn<QbStub, unknown[]>(),
    addOrderBy: jest.fn<QbStub, unknown[]>(),
    take: jest.fn<QbStub, unknown[]>(),
    getMany: jest.fn<Promise<unknown[]>, []>(),
  };
  qb.select.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.innerJoin.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);
  qb.getMany.mockResolvedValue(rows);
  return qb;
}

/**
 * The `forum_post` aggregate `FeedService.forumThreadCards` runs once per page
 * (ENG-132 / PRD-167): one grouped row per thread carrying the live
 * non-deleted reply count and the opening post's body. Terminal call is
 * `getRawMany`, so it needs its own chainable stub rather than `qbStub`'s
 * `getMany`.
 */
interface RawQbStub {
  select: jest.Mock<RawQbStub, unknown[]>;
  addSelect: jest.Mock<RawQbStub, unknown[]>;
  where: jest.Mock<RawQbStub, unknown[]>;
  andWhere: jest.Mock<RawQbStub, unknown[]>;
  groupBy: jest.Mock<RawQbStub, unknown[]>;
  getRawMany: jest.Mock<Promise<unknown[]>, []>;
}

function rawQbStub(rows: unknown[] = []): RawQbStub {
  const qb: RawQbStub = {
    select: jest.fn<RawQbStub, unknown[]>(),
    addSelect: jest.fn<RawQbStub, unknown[]>(),
    where: jest.fn<RawQbStub, unknown[]>(),
    andWhere: jest.fn<RawQbStub, unknown[]>(),
    groupBy: jest.fn<RawQbStub, unknown[]>(),
    getRawMany: jest.fn<Promise<unknown[]>, []>(),
  };
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.groupBy.mockReturnValue(qb);
  qb.getRawMany.mockResolvedValue(rows);
  return qb;
}

/** One row of that aggregate, as the driver returns it (`count(*)` is a
 *  bigint, so it arrives as a string). */
const threadCardRow = (
  threadId: string,
  replyCount: number,
  opBody: string | null,
) => ({
  thread_id: threadId,
  op_body: opBody,
  reply_count: String(replyCount),
});

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
  // Thread-level soft delete (contract C1). The feed excludes a deleted
  // thread (C2 / PRD-160), so the default row is a live one.
  deletedAt: null,
  deletedById: null,
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

/** PRD-107: a published magazine piece, as the `magazine_article` source's own
 *  projected query returns it. `publishedAt` is the ordering key, NOT
 *  `createdAt` — a piece drafted in March and shipped today belongs at the top
 *  of today's feed. */
const baseArticle = (
  overrides: Partial<MagazineArticle> = {},
): MagazineArticle =>
  ({
    id: 'article-1',
    slug: 'a-room-of-our-own',
    title: 'A room of our own',
    dek: 'What a decade of queer housing organising in Lisbon actually built.',
    kicker: 'Housing',
    section: 'Features',
    readMinutes: 9,
    heroImageKey: '',
    socialImage: '',
    publishedAt: t('2026-07-11T00:00:00.000Z'),
    authorId: 'byline-1',
    tags: [],
    locale: 'en',
    translationOfArticleId: null,
    ...overrides,
  }) as unknown as MagazineArticle;

/** The `magazine_author` row behind a byline. `userId` is the ONLY link to a
 *  member account, and it is what the block filter checks; a contributor
 *  credited by name only carries `null` there. */
const baseByline = (overrides: Partial<MagazineAuthor> = {}): MagazineAuthor =>
  ({
    id: 'byline-1',
    userId: null,
    slug: 'rita-mendes',
    name: 'Rita Mendes',
    bio: null,
    avatarUrl: null,
    ...overrides,
  }) as unknown as MagazineAuthor;

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
  let forumPosts: { createQueryBuilder: jest.Mock };
  let events: { createQueryBuilder: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let communityMembers: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let topicFollows: { find: jest.Mock };
  let memberPreferences: { findOne: jest.Mock };
  let magazineArticles: { createQueryBuilder: jest.Mock };
  let magazineAuthors: { find: jest.Mock };
  let blockFilter: { hiddenUserIds: jest.Mock };
  let hiddenFrom: { excludeHiddenFrom: jest.Mock };
  let connectionsService: { allAcceptedConnectionUserIds: jest.Mock };
  let feedInteractions: { forPosts: jest.Mock };
  let feedMutes: { mutedSources: jest.Mock };

  beforeEach(async () => {
    communityPosts = { createQueryBuilder: jest.fn(() => qbStub()) };
    communities = { find: jest.fn().mockResolvedValue([]) };
    forumThreads = { createQueryBuilder: jest.fn(() => qbStub()) };
    // ENG-132/PRD-167: the per-page `forum_post` aggregate. No rows by
    // default, which is a thread whose posts are all gone: the mapper's own
    // fallback then reports zero replies and no excerpt.
    forumPosts = { createQueryBuilder: jest.fn(() => rawQbStub()) };
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
    // PRD-107: the magazine publishes nothing by default, so every
    // pre-existing test sees the same four sources it always did.
    magazineArticles = { createQueryBuilder: jest.fn(() => qbStub()) };
    magazineAuthors = { find: jest.fn().mockResolvedValue([]) };
    // `dropBlocked` now resolves the whole page's hidden authors in one batched
    // `hiddenUserIds(viewerId, authorIds)` call (union of blocked + muted),
    // returning a Set, rather than one `isBlockedEitherWay`/`isMutedBy` call
    // per author.
    blockFilter = {
      hiddenUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // ENG-131: the directory's "hide my profile from this person" filter,
    // which the two new-member sources now apply in-query too. The real
    // service appends a NOT EXISTS to the builder it is handed and returns
    // it; the stub only has to be callable, since the assertions read the
    // arguments it was given.
    hiddenFrom = { excludeHiddenFrom: jest.fn() };
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
        { provide: getRepositoryToken(ForumPost), useValue: forumPosts },
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
        {
          provide: getRepositoryToken(MagazineArticle),
          useValue: magazineArticles,
        },
        {
          provide: getRepositoryToken(MagazineAuthor),
          useValue: magazineAuthors,
        },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: HiddenFromService, useValue: hiddenFrom },
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
      expect(decoded.windowCursor).toBeUndefined();
      expect(decoded.offset).toBe(2);
      // ENG-134: the first request stamps the window's ceiling and records
      // the last card it served, so page two re-materialises the same window
      // and resumes from immediately after that card.
      expect(decoded.anchorAt).toBeInstanceOf(Date);
      expect(decoded.lastKey).toBe('community_post:p3');
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

    // ENG-132: the card counts LIVE non-deleted replies, so the stale
    // `forum_thread.reply_count` column (never decremented when a reply is
    // tombstoned) no longer decides what the feed advertises.
    it("counts a forum thread's live replies rather than its stored column", async () => {
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ id: 'thread-1', replyCount: 7 })]),
      );
      forumPosts.createQueryBuilder.mockReturnValue(
        rawQbStub([threadCardRow('thread-1', 2, 'The opening post.')]),
      );

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      const thread = page.data.find((item) => item.type === 'forum_thread');
      expect(thread).toMatchObject({ replyCount: 2 });
      expect(thread?.summary).toBe('general · 2 replies');
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

  describe('profile privacy gates on the new-member sources (ENG-131)', () => {
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    // The member directory refuses both of these, and this source announces
    // the same people with their name, tagline or bio and a profile link. The
    // gates are applied IN-QUERY, mirroring
    // `ProfilesService.directoryBaseQuery`, so a page still fills to `limit`.
    it('excludes a member who hid themself for 24 hours', async () => {
      const profileQb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(profileQb);

      await service.getFeed('viewer-1', 'people', undefined);

      const call = predicateOf(profileQb, 'hidden_until');
      expect(call?.[0]).toBe(
        '("p"."hidden_until" IS NULL OR "p"."hidden_until" <= now())',
      );
    });

    it('excludes a member who hid their profile from this viewer', async () => {
      const profileQb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(profileQb);

      await service.getFeed('viewer-1', 'people', undefined);

      expect(hiddenFrom.excludeHiddenFrom).toHaveBeenCalledWith(
        profileQb,
        'viewer-1',
        '"p"."user_id"',
      );
    });

    // Same two gates, reached across from the MEMBERSHIP row this source is
    // built on to the joining member's profile.
    it('applies both gates to the community_new_member source too', async () => {
      const memberQb = qbStub([]);
      communityMembers.createQueryBuilder.mockReturnValue(memberQb);

      await service.getFeed('viewer-1', 'communities', undefined);

      const call = predicateOf(memberQb, 'feed_hidden_profile');
      expect(call?.[0]).toContain('"feed_hidden_profile"."hidden_until"');
      expect(call?.[0]).toContain('"feed_hidden_profile"."user_id"');
      expect(hiddenFrom.excludeHiddenFrom).toHaveBeenCalledWith(
        memberQb,
        'viewer-1',
        '"m"."user_id"',
      );
    });

    // Verified rather than assumed: the photo toggle was already honoured,
    // because every actor on every feed card is resolved through
    // `toMemberRef`, which is the single place `photoVisible` is applied.
    // This test pins that down; nothing changed for it.
    it('already withholds the avatar of a member who hid their photo', async () => {
      profiles.createQueryBuilder.mockReturnValue(
        qbStub([
          baseMemberProfile({
            userId: 'member-1',
            avatarUrl: 'members/member-1.jpg',
            photoVisible: false,
          }),
        ]),
      );
      profiles.find.mockResolvedValue([
        baseMemberProfile({
          userId: 'member-1',
          avatarUrl: 'members/member-1.jpg',
          photoVisible: false,
        }),
      ]);

      const page = await service.getFeed('viewer-1', 'people', undefined);

      expect(page.data[0]?.actor?.avatarUrl).toBeNull();
    });
  });

  describe('"New this week" date bound (PRD-168)', () => {
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    it('bounds the new-member source to members who joined inside the window', async () => {
      const profileQb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(profileQb);
      const before = Date.now();

      await service.getFeed('viewer-1', 'people', undefined, 20, 7);

      const call = predicateOf(profileQb, 'feedJoinedSince');
      expect(call?.[0]).toBe('"p"."created_at" >= :feedJoinedSince');
      const params = call?.[1] as { feedJoinedSince: Date } | undefined;
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(params?.feedJoinedSince.getTime()).toBeGreaterThanOrEqual(
        before - sevenDays - 1000,
      );
      expect(params?.feedJoinedSince.getTime()).toBeLessThanOrEqual(
        Date.now() - sevenDays + 1000,
      );
    });

    // Nobody joined this week is an honest empty list, which is what the
    // widget's empty state renders.
    it('returns an empty page when nobody joined inside the window', async () => {
      profiles.createQueryBuilder.mockReturnValue(qbStub([]));

      const page = await service.getFeed(
        'viewer-1',
        'people',
        undefined,
        20,
        7,
      );

      expect(page.data).toEqual([]);
      expect(page.pageInfo.hasMore).toBe(false);
    });

    // The tab itself is unchanged: it still shows the newest members however
    // long ago they joined.
    it('emits no date bound when the caller does not ask for one', async () => {
      const profileQb = qbStub([]);
      profiles.createQueryBuilder.mockReturnValue(profileQb);

      await service.getFeed('viewer-1', 'people', undefined);

      expect(predicateOf(profileQb, 'feedJoinedSince')).toBeUndefined();
    });
  });

  describe('deleted threads (contract C2 / PRD-160)', () => {
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    it('excludes a thread whose own row is soft-deleted', async () => {
      const threadQb = qbStub([]);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      expect(predicateOf(threadQb, '"t"."deleted_at" IS NULL')).toBeDefined();
    });

    it('excludes a thread whose opening post is tombstoned', async () => {
      const threadQb = qbStub([]);
      forumThreads.createQueryBuilder.mockReturnValue(threadQb);

      await service.getFeed('viewer-1', 'posts', undefined);

      const call = predicateOf(threadQb, 'feed_deleted_op');
      expect(call?.[0]).toContain('"feed_deleted_op"."is_op" = true');
      expect(call?.[0]).toContain('"feed_deleted_op"."deleted_at" IS NOT NULL');
    });
  });

  describe('forum card excerpt (contract C4 / PRD-167)', () => {
    it("previews the thread's opening post, HTML stripped", async () => {
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ id: 'thread-1' })]),
      );
      forumPosts.createQueryBuilder.mockReturnValue(
        rawQbStub([
          threadCardRow(
            'thread-1',
            1,
            '<p>Has anyone found a <b>good</b> queer choir in Lisbon?</p>',
          ),
        ]),
      );

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      const thread = page.data.find((item) => item.type === 'forum_thread');
      expect(thread?.excerpt).toBe(
        'Has anyone found a good queer choir in Lisbon?',
      );
    });

    it('cuts a long body on a word boundary at 180 characters and marks the cut', async () => {
      const longBody = `${'lisbon '.repeat(40)}end`;
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ id: 'thread-1' })]),
      );
      forumPosts.createQueryBuilder.mockReturnValue(
        rawQbStub([threadCardRow('thread-1', 0, longBody)]),
      );

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      const excerpt = page.data.find((item) => item.type === 'forum_thread')
        ?.excerpt as string;
      expect(excerpt.endsWith('…')).toBe(true);
      // 180 characters of body plus the one-character ellipsis.
      expect(excerpt.length).toBeLessThanOrEqual(181);
      expect(excerpt).not.toContain('end');
    });

    // Every post gone (the OP tombstoned) leaves no aggregate row at all: no
    // preview, and a count of zero rather than the stale stored one.
    it('carries a null excerpt and no replies when the thread has no live posts', async () => {
      forumThreads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ id: 'thread-1', replyCount: 5 })]),
      );
      forumPosts.createQueryBuilder.mockReturnValue(rawQbStub([]));

      const page = await service.getFeed('viewer-1', 'posts', undefined);

      const thread = page.data.find((item) => item.type === 'forum_thread');
      expect(thread?.excerpt).toBeNull();
      expect(thread?.replyCount).toBe(0);
    });
  });

  describe('ranked window anchoring (ENG-134)', () => {
    const predicateOf = (qb: QbStub, needle: string) =>
      qb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(needle),
      );

    const rankedRows = () =>
      [1, 2, 3, 4].map((index) =>
        basePost({
          id: `p${index}`,
          createdAt: t(`2026-07-2${index}T00:00:00.000Z`),
        }),
      );

    it('bounds the first window to the instant it was built', async () => {
      const postQb = qbStub(rankedRows());
      communityPosts.createQueryBuilder.mockReturnValue(postQb);

      await service.getFeed('viewer-1', 'all', undefined, 2);

      const call = predicateOf(postQb, 'feedWindowAnchor');
      expect(call?.[0]).toBe('"cp"."created_at" <= :feedWindowAnchor');
      expect(
        (call?.[1] as { feedWindowAnchor: Date } | undefined)?.feedWindowAnchor,
      ).toBeInstanceOf(Date);
    });

    // The bug: page two used to re-read the window from the top of the table,
    // so anything posted between the two requests shifted the ranked order
    // and a card repeated or vanished. Page two now re-materialises the SAME
    // window, because it carries the first request's ceiling back.
    it('re-uses the first window ceiling on page two', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rankedRows()));

      const first = await service.getFeed('viewer-1', 'all', undefined, 2);
      const firstAnchor = decodeRankedCursor(
        first.pageInfo.nextCursor as string,
      ).anchorAt;

      const secondQb = qbStub(rankedRows());
      communityPosts.createQueryBuilder.mockReturnValue(secondQb);
      await service.getFeed(
        'viewer-1',
        'all',
        first.pageInfo.nextCursor as string,
        2,
      );

      const call = predicateOf(secondQb, 'feedWindowAnchor');
      expect(
        (call?.[1] as { feedWindowAnchor: Date } | undefined)?.feedWindowAnchor,
      ).toEqual(firstAnchor);
    });

    it('serves each card exactly once across two pages of one window', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rankedRows()));

      const first = await service.getFeed('viewer-1', 'all', undefined, 2);
      const second = await service.getFeed(
        'viewer-1',
        'all',
        first.pageInfo.nextCursor as string,
        2,
      );

      expect(first.data.map((item) => item.id)).toEqual(['p4', 'p3']);
      expect(second.data.map((item) => item.id)).toEqual(['p2', 'p1']);
    });

    // A row LEAVING the window (deleted, muted, its author blocked) used to
    // pull an unseen card up into the slot the raw offset skips past. The
    // last key served re-locates the boundary instead.
    it('resumes after the last card served when a row left the window', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rankedRows()));
      const first = await service.getFeed('viewer-1', 'all', undefined, 2);
      expect(first.data.map((item) => item.id)).toEqual(['p4', 'p3']);

      // `p4` is gone by the time page two is built.
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub(rankedRows().filter((post) => post.id !== 'p4')),
      );
      const second = await service.getFeed(
        'viewer-1',
        'all',
        first.pageInfo.nextCursor as string,
        2,
      );

      // A raw offset of 2 would have started at `p1` and dropped `p2`.
      expect(second.data.map((item) => item.id)).toEqual(['p2', 'p1']);
    });

    it('falls back to the offset when the last card served is gone too', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(qbStub(rankedRows()));
      const first = await service.getFeed('viewer-1', 'all', undefined, 2);

      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub(rankedRows().filter((post) => post.id !== 'p3')),
      );
      const second = await service.getFeed(
        'viewer-1',
        'all',
        first.pageInfo.nextCursor as string,
        2,
      );

      expect(second.data.map((item) => item.id)).toEqual(['p1']);
    });
  });

  describe('magazine articles in the feed (PRD-107)', () => {
    /** Every `andWhere`/`where` predicate the magazine source built, as one
     *  searchable string. */
    const predicatesOf = (qb: QbStub): string =>
      [...qb.where.mock.calls, ...qb.andWhere.mock.calls]
        .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
        .join(' | ');

    it('surfaces a published article on the "all" tab as an `article` item', async () => {
      magazineArticles.createQueryBuilder.mockReturnValue(
        qbStub([baseArticle()]),
      );
      magazineAuthors.find.mockResolvedValue([baseByline()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data).toHaveLength(1);
      const item = page.data[0] as FeedItem;
      expect(item.type).toBe('article');
      expect(item.id).toBe('article-1');
      expect(item.title).toBe('A room of our own');
      expect(item.link).toBe('/magazine/article?id=a-room-of-our-own');
      // The ordering key is the PUBLISH instant, never `created_at`.
      expect(item.createdAt).toBe('2026-07-11T00:00:00.000Z');
      expect(item.kicker).toBe('Housing');
      expect(item.section).toBe('Features');
      expect(item.readMinutes).toBe(9);
      expect(item.locale).toBe('en');
      expect(item.byline).toEqual({
        name: 'Rita Mendes',
        slug: 'rita-mendes',
        avatarUrl: null,
      });
      // A byline credited by name only has no member account behind it, so
      // there is no `actor` to link to a profile.
      expect(item.actor).toBeNull();
    });

    it('gates on published_at being set, not in the future, and canonical-only', async () => {
      const articleQb = qbStub([]);
      magazineArticles.createQueryBuilder.mockReturnValue(articleQb);

      await service.getFeed('viewer-1', 'all', undefined);

      const predicates = predicatesOf(articleQb);
      expect(predicates).toContain('article.published_at IS NOT NULL');
      expect(predicates).toContain('article.published_at <= :magazineNow');
      expect(predicates).toContain('article.translation_of_article_id IS NULL');
    });

    it('orders and seeks on the raw published_at column, so the partial index can serve it', async () => {
      const articleQb = qbStub([]);
      magazineArticles.createQueryBuilder.mockReturnValue(articleQb);
      const cursor = encodeCursor({
        createdAt: t('2026-07-11T00:00:00.000Z'),
        id: 'article-9',
      });

      await service.getFeed('viewer-1', 'gatherings', cursor);
      // The magazine is not on the gatherings tab at all.
      expect(magazineArticles.createQueryBuilder).not.toHaveBeenCalled();

      await service.getFeed('viewer-1', 'all', cursor);
      expect(articleQb.orderBy).toHaveBeenCalledWith(
        '"article"."published_at"',
        'DESC',
      );
      expect(articleQb.addOrderBy).toHaveBeenCalledWith('article.id', 'DESC');
      // Raw column on BOTH sides, with no `date_trunc(...)` wrapper: the
      // column is only ever written from a JS Date, so it already matches the
      // cursor's millisecond resolution, and keeping it raw is what lets
      // `IDX_magazine_article_published_at` serve the seek.
      expect(predicatesOf(articleQb)).toContain(
        '("article"."published_at", article.id) < (:cursorCreatedAt, :cursorId)',
      );
      expect(predicatesOf(articleQb)).not.toContain('date_trunc');
    });

    it('is unioned into "all" only, never the scoped or single-source tabs', async () => {
      for (const tab of [
        'communities',
        'connections',
        'gatherings',
        'people',
        'posts',
      ] as const) {
        magazineArticles.createQueryBuilder.mockClear();
        await service.getFeed('viewer-1', tab, undefined);
        expect(magazineArticles.createQueryBuilder).not.toHaveBeenCalled();
      }
    });

    it('drops an article whose byline belongs to a member the viewer blocked', async () => {
      magazineArticles.createQueryBuilder.mockReturnValue(
        qbStub([baseArticle()]),
      );
      magazineAuthors.find.mockResolvedValue([
        baseByline({ userId: 'blocked-writer' }),
      ]);
      blockFilter.hiddenUserIds.mockResolvedValue(
        new Set<string>(['blocked-writer']),
      );

      const page = await service.getFeed('viewer-1', 'all', undefined);

      // Not even the byline reaches the home screen.
      expect(page.data).toHaveLength(0);
      expect(blockFilter.hiddenUserIds).toHaveBeenCalledWith('viewer-1', [
        'blocked-writer',
      ]);
    });

    it('excludes an article carrying a tag the viewer switched off (PRD-10)', async () => {
      memberPreferences.findOne.mockResolvedValue({
        hideDatingContent: false,
        hideMentalHealthContent: true,
        hideSexualityIdentityContent: false,
      });
      const articleQb = qbStub([]);
      magazineArticles.createQueryBuilder.mockReturnValue(articleQb);

      await service.getFeed('viewer-1', 'all', undefined);

      expect(predicatesOf(articleQb)).toContain(
        'NOT (article.tags && :excludedItemTags)',
      );
    });

    it('shows the reader-language translation without moving the piece or duplicating it', async () => {
      const canonical = baseArticle();
      const translation = baseArticle({
        id: 'article-1-pt',
        slug: 'um-quarto-so-nosso',
        title: 'Um quarto só nosso',
        locale: 'pt',
        translationOfArticleId: 'article-1',
        // Shipped a week after the original, and deliberately ignored for
        // ordering: the piece keeps its own place in the feed.
        publishedAt: t('2026-07-18T00:00:00.000Z'),
      });
      magazineArticles.createQueryBuilder
        .mockReturnValueOnce(qbStub([canonical]))
        .mockReturnValueOnce(qbStub([translation]));
      magazineAuthors.find.mockResolvedValue([baseByline()]);

      const page = await service.getFeed(
        'viewer-1',
        'all',
        undefined,
        undefined,
        undefined,
        'pt-PT',
      );

      expect(page.data).toHaveLength(1);
      const item = page.data[0] as FeedItem;
      // One row, in Portuguese, at the CANONICAL piece's id and instant.
      expect(item.id).toBe('article-1');
      expect(item.createdAt).toBe('2026-07-11T00:00:00.000Z');
      expect(item.title).toBe('Um quarto só nosso');
      expect(item.link).toBe('/magazine/article?id=um-quarto-so-nosso');
      expect(item.locale).toBe('pt');
    });

    it('runs no translation query at all for a reader on the default locale', async () => {
      magazineArticles.createQueryBuilder.mockReturnValue(
        qbStub([baseArticle()]),
      );
      magazineAuthors.find.mockResolvedValue([baseByline()]);

      await service.getFeed(
        'viewer-1',
        'all',
        undefined,
        undefined,
        undefined,
        'en-GB',
      );

      // One builder for the candidates, and nothing else.
      expect(magazineArticles.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('serves the piece as written when the language asked for has no translation', async () => {
      magazineArticles.createQueryBuilder
        .mockReturnValueOnce(qbStub([baseArticle()]))
        .mockReturnValueOnce(qbStub([]));
      magazineAuthors.find.mockResolvedValue([baseByline()]);

      const page = await service.getFeed(
        'viewer-1',
        'all',
        undefined,
        undefined,
        undefined,
        'pt',
      );

      const item = page.data[0] as FeedItem;
      expect(item.title).toBe('A room of our own');
      expect(item.locale).toBe('en');
    });

    it('resolves the byline in ONE batched query for a whole page of articles', async () => {
      magazineArticles.createQueryBuilder.mockReturnValue(
        qbStub([
          baseArticle({ id: 'article-1' }),
          baseArticle({ id: 'article-2', slug: 'two', authorId: 'byline-2' }),
          baseArticle({ id: 'article-3', slug: 'three' }),
        ]),
      );
      magazineAuthors.find.mockResolvedValue([
        baseByline(),
        baseByline({ id: 'byline-2', slug: 'ines-faria', name: 'Inês Faria' }),
      ]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      expect(page.data).toHaveLength(3);
      expect(magazineAuthors.find).toHaveBeenCalledTimes(1);
    });

    it('merges an article into the same newest-first order as every other source', async () => {
      communityPosts.createQueryBuilder.mockReturnValue(
        qbStub([basePost({ id: 'post-older' })]),
      );
      magazineArticles.createQueryBuilder.mockReturnValue(
        qbStub([baseArticle()]),
      );
      magazineAuthors.find.mockResolvedValue([baseByline()]);

      const page = await service.getFeed('viewer-1', 'all', undefined);

      // The post is 2026-07-10, the article 2026-07-11.
      expect(page.data.map((item) => item.type)).toEqual([
        'article',
        'community_post',
      ]);
    });
  });
});
