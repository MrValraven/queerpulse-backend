import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, IsNull } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { TopicPostLinkService } from '../content/topic-post-link.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { ModAuditService } from '../moderation/mod-audit.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumThreadFunding } from './entities/forum-thread-funding.entity';
import { CreateThreadFundingDto } from './dto/create-thread-funding.dto';
import {
  ASK_AUTO_END_MS,
  CALL_CLOSING_WINDOW_MS,
  ResolvedFundingFields,
  fundingException,
} from './forum-funding';
import { ForumFundingService } from './forum-funding.service';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { FORUM_THREAD_CREATED } from './forum.events';
import {
  FORUM_THREAD_VISIBLE_SQL,
  ForumThreadsService,
  forumOpNotTakenDownSql,
  forumThreadVisibleSql,
  isThreadPublished,
} from './forum-threads.service';
import {
  FORUM_POST_SEARCH_COLUMNS,
  FORUM_THREAD_SEARCH_COLUMNS,
  foldedHaystack,
  foldedSearchTerm,
} from '../search/search-text';

const GRINNING_FACE = '\u{1F600}';

// The accent-folded `q` branches of the forum list filter: the thread title,
// and the reply body inside the correlated EXISTS.
const FOLDED_FORUM_SEARCH_PATTERN = foldedSearchTerm('forumSearchPattern');
const FORUM_TITLE_SEARCH = `${foldedHaystack('t', FORUM_THREAD_SEARCH_COLUMNS)} LIKE ${FOLDED_FORUM_SEARCH_PATTERN}`;
const FORUM_BODY_SEARCH = `${foldedHaystack('__search_post', FORUM_POST_SEARCH_COLUMNS)} LIKE ${FOLDED_FORUM_SEARCH_PATTERN}`;

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
  // Funding & Grants: the funding views and the duplicate lookup join the
  // side table, and the lookup reads one row.
  innerJoin: jest.Mock<QbStub, unknown[]>;
  getOne: jest.Mock<Promise<ForumThread | null>, []>;
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
    innerJoin: jest.fn<QbStub, unknown[]>(),
    getOne: jest.fn<Promise<ForumThread | null>, []>(),
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
  qb.innerJoin.mockReturnValue(qb);
  qb.getOne.mockResolvedValue(rows[0] ?? null);
  return qb;
}

// A chainable `Community` query-builder stub for `isCommunityHiddenFrom`'s
// existence probe (`this.threads.manager.createQueryBuilder(Community, 'com')`):
// its terminal `getExists()` resolves to whether the thread's gated community
// hides itself from the viewer (H1). Every tier but `public` is gated.
//
// Typed rather than `Record<string, jest.Mock>` so a test can read
// `andWhere.mock.calls` without the arguments coming back as `any` (the same
// reason `QbStub` above is typed).
interface CommunityAccessQbStub {
  where: jest.Mock<CommunityAccessQbStub, unknown[]>;
  andWhere: jest.Mock<CommunityAccessQbStub, unknown[]>;
  getExists: jest.Mock<Promise<boolean>, []>;
}

function communityAccessQbStub(isHidden: boolean): CommunityAccessQbStub {
  const qb: CommunityAccessQbStub = {
    where: jest.fn<CommunityAccessQbStub, unknown[]>(),
    andWhere: jest.fn<CommunityAccessQbStub, unknown[]>(),
    getExists: jest.fn<Promise<boolean>, []>(),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.getExists.mockResolvedValue(isHidden);
  return qb;
}

/**
 * Every tier the platform has, so a per-tier expectation covers the whole
 * enum rather than the three tiers that happen to exist today.
 */
const ALL_ACCESS_TIERS: readonly AccessTier[] = Object.values(AccessTier);

/** The `andWhere` call that carries the community access-tier gate. */
function accessTierGateCall(qb: QbStub): {
  sql: string;
  parameters: Record<string, unknown>;
} {
  const gateCall = qb.andWhere.mock.calls.find(
    (call) => typeof call[0] === 'string' && call[0].includes('access_tier'),
  );
  expect(gateCall).toBeDefined();
  return {
    sql: String(gateCall?.[0]),
    parameters: (gateCall?.[1] ?? {}) as Record<string, unknown>,
  };
}

/**
 * The access tiers `applyCommunityAccessFilter` admits for a viewer who is NOT
 * on the community's roster, read straight off the predicate it built.
 *
 * The gate is one SQL string handed to a stubbed query builder, so a per-tier
 * assertion has to evaluate the one comparison inside it that decides tier
 * admission (`"com"."access_tier" <operator> :<bound parameter>`) against the
 * parameter the service bound. That gives each tier its own named expectation
 * and still fails loudly if the comparison ever flips back to `!=`, which
 * would readmit `request` and `invite` to an outsider's browse list. Mirrors
 * the helper of the same name in `feed.service.spec.ts`, which pins the same
 * rule on the other surface.
 */
function tiersAdmittedForNonMember(
  predicateSql: string,
  parameters: Record<string, unknown>,
): AccessTier[] {
  const tierTest = /"com"\."access_tier"\s*(=|!=)\s*:(\w+)/.exec(predicateSql);
  if (!tierTest) return [];
  const [, operator, parameterName] = tierTest;
  const boundTier = parameters[parameterName ?? ''] as AccessTier | undefined;
  return ALL_ACCESS_TIERS.filter((tier) =>
    operator === '=' ? tier === boundTier : tier !== boundTier,
  );
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
  kind: null,
  contentWarnings: [],
  isAnonymous: false,
  coAuthorId: null,
  // Mirrors `createdAt`: `AddForumRichComposer1817300000000` backfills
  // `published_at` from `created_at`, so a live fixture is a published one.
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
  reviewState: null,
  // A thread that exists on the forum has already made its announcement —
  // see `ForumThread.fannedOutAt`. Tests that exercise the deferred fan-out
  // override this to null.
  fannedOutAt: new Date('2026-01-01T00:00:00.000Z'),
  crossPosted: false,
  neighbourhood: null,
  closesAt: null,
  language: null,
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

// Funding & Grants: the code a coded funding error carries, or undefined.
async function fundingCodeOf(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  return undefined;
}

const callFunding: CreateThreadFundingDto = {
  linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
  funderName: 'Fundação Gulbenkian',
  deadline: '2026-12-01T23:59:00.000Z',
  eligibility: ['individuals'],
  scope: 'national',
};

const resolvedCall: ResolvedFundingFields = {
  kind: 'call',
  linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
  linkHost: 'gulbenkian.pt',
  linkKey: 'gulbenkian.pt/bolsas/arte-queer',
  funderName: 'Fundação Gulbenkian',
  amountMin: null,
  amountMax: null,
  deadline: new Date('2026-12-01T23:59:00.000Z'),
  eligibility: ['individuals'],
  scope: 'national',
  goalAmount: null,
  askPurpose: null,
  beneficiary: null,
  endsAt: null,
};

// A call closing in three days, so the mapped view reads `closing`.
const makeFundingRow = (
  overrides: Partial<ForumThreadFunding> = {},
): ForumThreadFunding => ({
  threadId: 'thread-1',
  linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
  linkKey: 'gulbenkian.pt/bolsas/arte-queer',
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
  funderName: 'Fundação Gulbenkian',
  amountMin: null,
  amountMax: 5000,
  deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
  eligibility: ['individuals'],
  scope: 'national',
  goalAmount: null,
  askPurpose: null,
  beneficiary: null,
  endsAt: null,
  endedAt: null,
  endedReason: null,
  approvedAt: null,
  ...overrides,
});

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
    manager: {
      createQueryBuilder: jest.Mock;
      query: jest.Mock;
      find: jest.Mock;
    };
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
    blockedUserIds: jest.Mock;
  };
  let mentions: { notify: jest.Mock; forumThreadAudience: jest.Mock };
  // DISC-5's topics reconciliation and the author's own review-verdict bell —
  // the two halves of the create fan-out that reach other members, hoisted so
  // the deferred-fan-out specs can assert on exactly when each one fires.
  let topicPostLink: { linkThread: jest.Mock };
  let notifications: { create: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  // PRD-167 — the thread card's `excerpt` has to know whether a moderator took
  // the OP down. Default: nothing moderated. `stateFor` is the community
  // takedown read behind thread create and the reply gate, fully visible by
  // default.
  let contentModeration: { statesForAnyType: jest.Mock; stateFor: jest.Mock };
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
  // Community roster lookups: `assertMemberBySlug` on create and `isMember`
  // on the reply gate (PRD-407 pins that cross-posting leaves it closed).
  // `slugById` and `isOwnerOrMod` back the community takedown gate.
  let membership: {
    assertMemberBySlug: jest.Mock;
    isMember: jest.Mock;
    slugById: jest.Mock;
    isOwnerOrMod: jest.Mock;
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
  // Funding & Grants: the side-table service, stubbed so a thread with no
  // funding behaves exactly as before (no row, no errors).
  let funding: {
    resolveForCreate: jest.Mock;
    insertForThread: jest.Mock;
    rowsByThread: jest.Mock;
    prepareEdit: jest.Mock;
    saveEdit: jest.Mock;
    emitDeadlineChanged: jest.Mock;
    assertCanPostAsk: jest.Mock;
    assertAskLimit: jest.Mock;
    assertAskTextAllowed: jest.Mock;
    sendBackToReview: jest.Mock;
    onOpBodyEdit: jest.Mock;
    markAskApproved: jest.Mock;
    endAsk: jest.Mock;
    reviewFactsFor: jest.Mock;
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
        // The two batched composer reads that go through the entity manager:
        // `pollViewsByThread` (polls, their options, the viewer's ballots) and
        // `photoRowsByPost` (the OPs' photos). Default: no polls and no photo
        // rows anywhere, so every card comes back with `poll: null` and
        // `opPhotos: []`.
        find: jest.fn().mockResolvedValue([]),
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
      // PRD-408: the byline's co-author block read. Default: no blocks.
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // `create` fires a mention scan on the OP body; return no notified users.
    // `forumThreadAudience` holds the co-author credit notice to the thread's
    // readers (PRD-408). Default: every candidate can read the thread.
    mentions = {
      notify: jest.fn().mockResolvedValue(new Set<string>()),
      forumThreadAudience: jest.fn((_slug: string, userIds: string[]) =>
        Promise.resolve(new Set(userIds)),
      ),
    };
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map<string, unknown>()),
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };
    topicPostLink = { linkThread: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    eventEmitter = { emit: jest.fn() };

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

    membership = {
      assertMemberBySlug: jest.fn(),
      // Roster check behind `assertCanReplyInThread`. Default: on the roster.
      isMember: jest.fn().mockResolvedValue(true),
      // The takedown gate's slug lookup and staff exemption. Default: a known
      // community, and the caller is not its staff.
      slugById: jest.fn().mockResolvedValue('lisbon-hikers'),
      isOwnerOrMod: jest.fn().mockResolvedValue(false),
    };

    funding = {
      resolveForCreate: jest.fn().mockReturnValue(null),
      insertForThread: jest.fn(),
      rowsByThread: jest.fn().mockResolvedValue(new Map()),
      prepareEdit: jest.fn(),
      saveEdit: jest.fn().mockResolvedValue(undefined),
      emitDeadlineChanged: jest.fn(),
      assertCanPostAsk: jest.fn().mockResolvedValue(undefined),
      assertAskLimit: jest.fn().mockResolvedValue(undefined),
      assertAskTextAllowed: jest.fn(),
      sendBackToReview: jest.fn().mockResolvedValue(false),
      onOpBodyEdit: jest.fn().mockResolvedValue(undefined),
      markAskApproved: jest.fn().mockResolvedValue(undefined),
      endAsk: jest.fn(),
      reviewFactsFor: jest.fn().mockResolvedValue(new Map()),
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
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: CommunityMembershipService, useValue: membership },
        // `TopicPostLinkService` (thread-create tag reconciliation) and
        // `ModAuditService` (BE-COM-19's lock/pin/official audit rows) are
        // constructor dependencies of the service under test — stubbed here
        // so Nest can instantiate it; neither is exercised by these specs.
        { provide: TopicPostLinkService, useValue: topicPostLink },
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
        // The author's word on a moderator's review verdict.
        { provide: NotificationsService, useValue: notifications },
        // Funding & Grants: calls and fundraisers live in a side table.
        { provide: ForumFundingService, useValue: funding },
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

    // ENG-494: `forum_thread.author_id` is `ON DELETE SET NULL`, so a thread
    // outlives its author's erasure and keeps its replies on the list.
    it('lists a thread whose author was erased under the placeholder author', async () => {
      const qb = qbStub([baseThread({ authorId: null, replyCount: 3 })]);
      threads.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
      );

      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toEqual(
        expect.objectContaining({
          slug: 'hello-world',
          replyCount: 3,
          canEdit: false,
          author: { handle: '', displayName: 'Member', avatarUrl: null },
        }),
      );
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

    it('block check is skipped for a null thread author', async () => {
      // ENG-494: an erased author blocks nobody, so a viewer reaches the
      // thread and the block lookup is never asked about a null id.
      threads.findOne.mockResolvedValue(baseThread({ authorId: null }));

      const thread = await service.loadOr404('hello-world', 'viewer-1');

      expect(thread.slug).toBe('hello-world');
      expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
    });

    it('skips the community access probe for a flat/global thread (H1)', async () => {
      threads.findOne.mockResolvedValue(baseThread({ communityId: null }));

      await service.loadOr404('hello-world', 'viewer-1');

      expect(threads.manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('404s a non-member reading a gated-community thread (H1)', async () => {
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

  // Every tier but `public` closes its community's content to anyone off the
  // roster: `GET /communities/:slug` answers 403 `COMMUNITY_MEMBERS_ONLY` and
  // `CommunityPostsService.assertViewable` refuses the board, so the forum must
  // not hand a gated community's thread titles back through a different door.
  // The gate used to test `access_tier != 'private'`, which left a `request`-
  // or `invite`-tier community's threads in the browse list of somebody that
  // community had refused.
  describe('list community access (H1)', () => {
    const gatedTierCases: ReadonlyArray<[string, AccessTier]> = [
      ['request', AccessTier.Request],
      ['invite', AccessTier.Invite],
      // Unchanged behaviour, pinned so a future rewrite of the tier test
      // cannot quietly reopen the tier that was closed all along.
      ['private', AccessTier.Private],
    ];

    const browseGate = async (): Promise<{
      sql: string;
      parameters: Record<string, unknown>;
    }> => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);
      await service.list('viewer-1', undefined, undefined, undefined);
      return accessTierGateCall(qb);
    };

    it('gates the browse list on "is public", binding the public tier', async () => {
      const { sql, parameters } = await browseGate();

      expect(sql).toContain('"com"."access_tier" = :publicTier');
      expect(sql).not.toContain('!=');
      expect(parameters).toEqual({
        publicTier: AccessTier.Public,
        viewerId: 'viewer-1',
      });
    });

    it.each(gatedTierCases)(
      'keeps a %s-tier community thread out of a non-member browse list',
      async (_tierName: string, tier: AccessTier) => {
        const { sql, parameters } = await browseGate();

        expect(tiersAdmittedForNonMember(sql, parameters)).not.toContain(tier);
      },
    );

    it('still lists a public-tier community thread for a non-member', async () => {
      const { sql, parameters } = await browseGate();

      expect(tiersAdmittedForNonMember(sql, parameters)).toEqual([
        AccessTier.Public,
      ]);
    });

    it('still lists a gated community thread for a viewer on its roster', async () => {
      // The roster branch is what admits a gated community's thread, so it has
      // to survive the tier change: without it, closing `request`/`invite`
      // would hide a member's own community from the forum.
      const { sql, parameters } = await browseGate();

      expect(sql).toMatch(
        /OR EXISTS \(\s*SELECT 1 FROM "community_members" "mem"\s*WHERE "mem"\."community_id" = t\.community_id\s*AND "mem"\."user_id" = :viewerId/,
      );
      expect(parameters.viewerId).toBe('viewer-1');
    });

    it('leaves flat/global threads (community_id IS NULL) visible to everyone', async () => {
      const { sql } = await browseGate();

      expect(sql).toContain('t.community_id IS NULL');
    });

    it("never opens the public-tier arm for a space's thread to a non-member", async () => {
      // A space's own public tier alone must not admit its thread here. Only
      // the roster branch (tested above) or the space's PARENT being public
      // does, mirroring `FeedService`'s equivalent arm.
      const { sql } = await browseGate();

      expect(sql).toMatch(
        /"com"\."access_tier" = :publicTier\s*AND "com"\."parent_id" IS NULL/,
      );
    });

    it('admits a gated space thread to parent staff and requires the parent row on the roster arm', async () => {
      // Spec gate matrix: parent owners, co-owners and mods act in every
      // space with no space roster row, and a space row whose parent row is
      // gone grants nothing.
      const { sql } = await browseGate();

      expect(sql).toContain(
        "\"staff_pm\".\"role\" IN ('owner', 'co_owner', 'mod')",
      );
      expect(sql).toMatch(
        /"mem"\."user_id" = :viewerId\s*AND EXISTS \(\s*SELECT 1 FROM "communities" "own_c"/,
      );
      expect(sql).toContain('"own_pm"."community_id" = "own_c"."parent_id"');
    });

    it('binds the same gate on counts and listPinned', async () => {
      // One private helper serves `list`/`counts`/`listPinned`/`searchByText`,
      // and a badge or a sticky row that counts a thread the list will not
      // draw is the same leak in a smaller frame.
      const countsQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(countsQb);
      await service.counts('viewer-1', undefined, undefined);
      expect(accessTierGateCall(countsQb).parameters).toEqual({
        publicTier: AccessTier.Public,
        viewerId: 'viewer-1',
      });

      const pinnedQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(pinnedQb);
      await service.listPinned('viewer-1', undefined, false);
      expect(accessTierGateCall(pinnedQb).parameters).toEqual({
        publicTier: AccessTier.Public,
        viewerId: 'viewer-1',
      });
    });
  });

  // The single-thread counterpart, `isCommunityHiddenFrom`, reads the same rule
  // inverted: it is TRUE when the community must be hidden, so its tier half
  // asks for the gated tiers rather than for `public`. The list is derived from
  // `isGatedTier`, so a tier added later hides its content until somebody
  // deliberately opens it.
  describe('loadOr404 community access by tier (H1)', () => {
    const gatedTiers = async (): Promise<AccessTier[]> => {
      const probeQb = communityAccessQbStub(true);
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'com-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(probeQb);

      await expect(
        service.loadOr404('hello-world', 'outsider-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      const tierCall = probeQb.andWhere.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('accessTier'),
      );
      expect(tierCall).toBeDefined();
      const parameters = (tierCall?.[1] ?? {}) as {
        gatedTiers?: readonly AccessTier[];
      };
      return [...(parameters.gatedTiers ?? [])];
    };

    it('probes every gated tier, not `private` alone', async () => {
      const probeQb = communityAccessQbStub(true);
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'com-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(probeQb);

      await expect(
        service.loadOr404('hello-world', 'outsider-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(probeQb.andWhere).toHaveBeenCalledWith(
        'com.accessTier IN (:...gatedTiers)',
        {
          gatedTiers: [
            AccessTier.Request,
            AccessTier.Invite,
            AccessTier.Private,
          ],
        },
      );
    });

    it('does not hide a public space thread from a reader who clears the parent gate, including parent staff with no space roster row', async () => {
      // `isCommunityHiddenFrom` is a single-thread read gate reached from a
      // direct link, the same door the space's own page and posts stay open
      // through. Narrowing it to roster-membership-only would 404 a thread
      // for a parent owner/co-owner/mod, who inherits staff standing in the
      // space without holding a roster row there.
      const probeQb = communityAccessQbStub(false);
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'space-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(probeQb);

      const thread = await service.loadOr404('hello-world', 'parent-staff-1');

      expect(thread.slug).toBe('hello-world');
    });

    const hiddenTierCases: ReadonlyArray<[string, AccessTier]> = [
      ['request', AccessTier.Request],
      ['invite', AccessTier.Invite],
      ['private', AccessTier.Private],
    ];

    it.each(hiddenTierCases)(
      'hides a %s-tier community thread from a non-member',
      async (_tierName: string, tier: AccessTier) => {
        expect(await gatedTiers()).toContain(tier);
      },
    );

    it('never hides a public-tier community thread from a non-member', async () => {
      expect(await gatedTiers()).not.toContain(AccessTier.Public);
    });

    it('requires the viewer to be off the roster before hiding anything', async () => {
      // The membership half of the probe: a roster member of a gated community
      // still reads the thread (the `returns the thread for a roster member`
      // case above covers the outcome; this pins the predicate that produces
      // it).
      const probeQb = communityAccessQbStub(true);
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'com-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(probeQb);

      await expect(
        service.loadOr404('hello-world', 'outsider-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      const membershipCall = probeQb.andWhere.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('community_members'),
      );
      expect(String(membershipCall?.[0])).toContain('NOT EXISTS');
      expect(membershipCall?.[1]).toEqual({ viewerId: 'outsider-1' });
    });

    it('lets parent staff through a gated space and drops a space row without its parent row', async () => {
      const probeQb = communityAccessQbStub(true);
      threads.findOne.mockResolvedValue(baseThread({ communityId: 'space-1' }));
      threads.manager.createQueryBuilder.mockReturnValue(probeQb);

      await expect(
        service.loadOr404('hello-world', 'outsider-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      const membershipCall = probeQb.andWhere.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('community_members'),
      );
      const predicateSql = String(membershipCall?.[0]);
      expect(predicateSql).toContain('AND NOT EXISTS (');
      expect(predicateSql).toContain('"staff_pm"."role" IN');
      expect(predicateSql).toContain('"own_pm"."user_id" = :viewerId');
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

    // P0 (Funding & Grants spec): the composer offers anonymity in six
    // categories, and the server used to honour three, publishing a legal or
    // relationships question under the author's name without a word.
    it.each([
      'health',
      'housing',
      'trans',
      'legal',
      'relationships',
      'funding',
    ])('keeps an anonymous post in %s anonymous', async (category) => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const response = await service.create('author-1', {
        title: 'Asking quietly',
        body: 'A question I would rather not sign',
        category,
        isAnonymous: true,
      });

      expect(response.isAnonymous).toBe(true);
      expect(response.author).toEqual({
        handle: '',
        displayName: 'Anonymous member',
        avatarUrl: null,
      });
    });

    it('stores a legal-category anonymous post as anonymous whatever its case', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.create('author-1', {
        title: 'Name change paperwork',
        body: 'How long did yours take at the Conservatória?',
        category: 'Legal',
        isAnonymous: true,
      });

      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      expect(threadsRepositoryInTransaction.save).toHaveBeenCalledWith(
        expect.objectContaining({ isAnonymous: true, category: 'Legal' }),
      );
    });

    it('still signs an anonymous request in a general category', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      const response = await service.create('author-1', {
        title: 'Best coffee in Arroios',
        body: 'Asking for a friend',
        category: 'general',
        isAnonymous: true,
      });

      expect(response.isAnonymous).toBe(false);
      expect(response.author.displayName).toBe('Ava Lee');
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
        String(sql).includes(FORUM_TITLE_SEARCH),
      );
      expect(searchCall).toBeDefined();
      const sql = String(searchCall?.[0]);
      // A correlated EXISTS, never a join: a join would multiply the thread row
      // once per matching reply and break the keyset page.
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('"__search_post"."thread_id" = t.id');
      expect(sql).toContain(FORUM_BODY_SEARCH);
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
        String(sql).includes(FORUM_TITLE_SEARCH),
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
          String(sql).includes(FOLDED_FORUM_SEARCH_PATTERN),
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
        String(sql).includes(FORUM_TITLE_SEARCH),
      );
      expect(searchCall).toBeDefined();
      expect(String(searchCall?.[0])).toContain(FORUM_BODY_SEARCH);
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

    it('keeps the gated-community gate', async () => {
      const qb = searchQb();

      await service.searchByText('viewer-1', 'sao', 6);

      const communityCall = qb.andWhere.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('community_members'),
      );
      expect(communityCall).toBeDefined();
      expect(communityCall?.[1]).toEqual({
        publicTier: AccessTier.Public,
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
        expect.any(Date),
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

  /**
   * The scheduled / under-review read gate.
   *
   * Two halves are pinned here. The SHAPE of the predicate, because
   * `AddForumRichComposer1817300000000` built both hot keyset indexes partial
   * on the review disjunction written exactly one way and Postgres's predicate
   * prover matches it arm for arm; and the BYPASSES, because the whole point of
   * hiding an unpublished thread is that its author and the moderators can
   * still reach it.
   */
  describe('scheduled and under-review threads (read gate)', () => {
    // The `andWhere` calls carrying any part of the gate. One call, always: the
    // arms split across two would stop matching the partial index predicate.
    const gateCalls = (qb: QbStub): string[] =>
      qb.andWhere.mock.calls
        .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
        .filter(
          (sql) => sql.includes('review_state') || sql.includes('published_at'),
        );

    it('emits the review disjunction verbatim, arm for arm', () => {
      // Frozen text. `AddForumRichComposer1817300000000` writes
      // `("review_state" IS NULL OR "review_state" = 'approved')` into both
      // partial index predicates; a rewrite here (IS DISTINCT FROM, COALESCE,
      // the arms reordered) is logically equivalent and silently unindexed.
      expect(FORUM_THREAD_VISIBLE_SQL).toBe(
        "t.published_at <= now() AND (t.review_state IS NULL OR t.review_state = 'approved')",
      );
      expect(FORUM_THREAD_VISIBLE_SQL).toContain(
        "(t.review_state IS NULL OR t.review_state = 'approved')",
      );
    });

    it('keeps the same arms in the same order under another alias', () => {
      // `SavedAvailabilityService` runs this gate over its own `thread` alias.
      // The alias is the ONLY thing that may differ: the arms and their order
      // are what the planner's predicate prover matches on, so a template that
      // reordered or rewrote them under a different alias would hand one caller
      // an indexed predicate and the other an unindexed one.
      expect(forumThreadVisibleSql('"thread"')).toBe(
        '"thread".published_at <= now() AND ' +
          '("thread".review_state IS NULL OR "thread".review_state = \'approved\')',
      );
      expect(forumThreadVisibleSql('t')).toBe(FORUM_THREAD_VISIBLE_SQL);
    });

    it('folds it onto the browse list as ONE andWhere', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      expect(qb.andWhere).toHaveBeenCalledWith(FORUM_THREAD_VISIBLE_SQL);
      expect(gateCalls(qb)).toEqual([FORUM_THREAD_VISIBLE_SQL]);
    });

    it('keeps the gate on both keyset paths, including the top window probe', async () => {
      // `paginateTop` counts the window on a CLONE of the fully-filtered
      // builder, so the gate has to be folded on before the sort branches.
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined, 'top');
      expect(gateCalls(qb)).toEqual([FORUM_THREAD_VISIBLE_SQL]);

      const unansweredQb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(unansweredQb);
      await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
        'unanswered',
      );
      expect(gateCalls(unansweredQb)).toEqual([FORUM_THREAD_VISIBLE_SQL]);
    });

    it('does not gate a moderator browse', async () => {
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

      expect(gateCalls(staffQb)).toEqual([]);
    });

    it('carries the same gate on counts, the pinned bucket and search', async () => {
      const countsQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(countsQb);
      await service.counts('viewer-1', undefined, undefined);
      expect(gateCalls(countsQb)).toEqual([FORUM_THREAD_VISIBLE_SQL]);

      const pinnedQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(pinnedQb);
      await service.listPinned('viewer-1', undefined, false);
      expect(gateCalls(pinnedQb)).toEqual([FORUM_THREAD_VISIBLE_SQL]);

      const searchQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(searchQb);
      await service.searchByText('viewer-1', 'hrt', 10);
      expect(gateCalls(searchQb)).toEqual([FORUM_THREAD_VISIBLE_SQL]);
    });

    it('does not gate the staff pinned bucket', async () => {
      const staffPinnedQb = qbStub();
      threads.createQueryBuilder.mockReturnValue(staffPinnedQb);

      await service.listPinned('mod-1', undefined, true);

      expect(gateCalls(staffPinnedQb)).toEqual([]);
    });

    const scheduled = (): ForumThread =>
      baseThread({ publishedAt: new Date(Date.now() + 60_000) });

    it('404s a scheduled thread for anybody else', async () => {
      threads.findOne.mockResolvedValue(scheduled());

      await expect(
        service.getBySlug('hello-world', 'viewer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still serves a scheduled thread to its own author', async () => {
      // The author bypass lives on the single-row gate, not as an OR arm on the
      // browse query, precisely so the browse query keeps its keyset.
      threads.findOne.mockResolvedValue(scheduled());

      const dto = await service.getBySlug('hello-world', 'author-1');

      expect(dto.slug).toBe('hello-world');
    });

    it('still serves a scheduled thread to a moderator', async () => {
      threads.findOne.mockResolvedValue(scheduled());

      const dto = await service.getBySlug('hello-world', 'mod-1', true);

      expect(dto.slug).toBe('hello-world');
    });

    it.each([['pending'], ['rejected']])(
      '404s a %s thread for anybody but its author and staff',
      async (reviewState: string) => {
        threads.findOne.mockResolvedValue(baseThread({ reviewState }));

        await expect(
          service.getBySlug('hello-world', 'viewer-1'),
        ).rejects.toBeInstanceOf(NotFoundException);

        threads.findOne.mockResolvedValue(baseThread({ reviewState }));
        await expect(
          service.getBySlug('hello-world', 'author-1'),
        ).resolves.toMatchObject({ reviewState });
      },
    );

    it('serves an approved thread, and one nobody ever submitted', async () => {
      // NULL is "never submitted for review", which is the state of nearly
      // every thread on the forum and is VISIBLE. Reading it as "unreviewed,
      // therefore hidden" would empty the forum.
      threads.findOne.mockResolvedValue(
        baseThread({ reviewState: 'approved' }),
      );
      await expect(
        service.getBySlug('hello-world', 'viewer-1'),
      ).resolves.toMatchObject({ reviewState: 'approved' });

      threads.findOne.mockResolvedValue(baseThread({ reviewState: null }));
      await expect(
        service.getBySlug('hello-world', 'viewer-1'),
      ).resolves.toMatchObject({ reviewState: null });
    });

    it('lets staff actions reach a thread that has not published', async () => {
      // Lock/pin/official/delete all pass `includeUnpublished`, so a moderator
      // handling a report on a scheduled thread is not blocked by the gate.
      threads.findOne.mockResolvedValue(scheduled());

      await expect(
        service.setLocked('hello-world', moderator, true),
      ).resolves.toMatchObject({ isLocked: true });
    });
  });
  // ---------------------------------------------------------------------------
  // The deferred create fan-out (`fannedOutAt` / `publishThread`)
  // ---------------------------------------------------------------------------
  describe('the deferred create fan-out', () => {
    // The claim `publishThread` issues is an UPDATE builder, not the SELECT
    // builder `qbStub` models. `affected` is what decides which caller fans
    // out, so it is the whole point of this stub.
    interface UpdateQbStub {
      update: jest.Mock;
      set: jest.Mock;
      where: jest.Mock;
      execute: jest.Mock;
    }
    const updateQbStub = (affected: number): UpdateQbStub => {
      const qb: UpdateQbStub = {
        update: jest.fn(() => qb),
        set: jest.fn(() => qb),
        where: jest.fn(() => qb),
        execute: jest.fn(() => Promise.resolve({ affected })),
      };
      return qb;
    };

    // A thread that is visible now and still owes its announcement: exactly the
    // state a scheduled thread lands in the moment its instant passes.
    const owing = (overrides: Partial<ForumThread> = {}): ForumThread =>
      baseThread({ fannedOutAt: null, ...overrides });

    const opWithBody = {
      id: 'op-1',
      threadId: 'thread-1',
      authorId: 'author-1',
      body: 'Come and help, @ana',
      deletedAt: null,
      editedAt: null,
    };

    // The entity `createWithUniqueSlug` handed the transaction's repository —
    // where `fannedOutAt` is set, and therefore where "did this thread announce
    // itself on insert" is actually decided.
    const savedThreadOnCreate = (): ForumThread => {
      const repo = manager.getRepository(ForumThread) as { create: jest.Mock };
      return repo.create.mock.calls[0][0] as ForumThread;
    };

    beforeEach(() => {
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue(opWithBody);
    });

    it('announces a thread published straight away, in the create request', async () => {
      await service.create('author-1', {
        title: 'Hello, World!',
        body: 'First post body, @ana',
        category: 'general',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        FORUM_THREAD_CREATED,
        expect.objectContaining({ authorId: 'author-1' }),
      );
      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(1);
      expect(mentions.notify).toHaveBeenCalledTimes(1);
      // And the row is written already marked, so nothing can repeat it: the
      // insert is its own claim.
      const saved = savedThreadOnCreate();
      expect(saved.fannedOutAt).toBeInstanceOf(Date);
    });

    it('announces NOTHING for a thread created pending review', async () => {
      await service.create('author-1', {
        title: 'Hello, World!',
        // The excerpt is the disclosure: this body must not reach anybody
        // before a moderator has read the thread.
        body: 'A health question, @ana',
        category: 'health',
        submitForReview: true,
      });

      expect(mentions.notify).not.toHaveBeenCalled();
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      const saved = savedThreadOnCreate();
      expect(saved.reviewState).toBe('pending');
      // Owed, not cancelled.
      expect(saved.fannedOutAt).toBeNull();
    });

    it('announces NOTHING for a thread created scheduled for later', async () => {
      await service.create('author-1', {
        title: 'Hello, World!',
        body: 'Next week, @ana',
        category: 'general',
        publishAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      expect(mentions.notify).not.toHaveBeenCalled();
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      const saved = savedThreadOnCreate();
      expect(saved.fannedOutAt).toBeNull();
    });

    it('pays the debt on the first read that sees the thread is visible', async () => {
      threads.findOne.mockResolvedValue(owing());
      threads.createQueryBuilder.mockReturnValue(updateQbStub(1));

      await service.getBySlug('hello-world', 'viewer-1');

      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(1);
      expect(mentions.notify).toHaveBeenCalledTimes(1);
      expect(mentions.notify).toHaveBeenCalledWith(
        opWithBody.body,
        'author-1',
        expect.objectContaining({
          threadSlug: 'hello-world',
          excerpt: opWithBody.body,
        }),
      );
    });

    it('fans out EXACTLY ONCE when two reads observe the same newly visible thread', async () => {
      // Both requests hold a row whose `fannedOutAt` is still null, which is
      // precisely the stale in-memory read the conditional UPDATE exists to
      // defend: the database, not the caller, decides who won.
      threads.findOne.mockResolvedValue(owing());
      threads.createQueryBuilder
        .mockReturnValueOnce(updateQbStub(1))
        .mockReturnValue(updateQbStub(0));

      await Promise.all([
        service.getBySlug('hello-world', 'viewer-1'),
        service.getBySlug('hello-world', 'viewer-2'),
      ]);

      expect(threads.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(1);
      expect(mentions.notify).toHaveBeenCalledTimes(1);
    });

    it('never fans out a thread that is still scheduled, or still pending', async () => {
      threads.findOne.mockResolvedValue(
        owing({ publishedAt: new Date(Date.now() + 60_000) }),
      );
      await service.getBySlug('hello-world', 'author-1');

      threads.findOne.mockResolvedValue(owing({ reviewState: 'pending' }));
      await service.getBySlug('hello-world', 'author-1');

      // Not even the claim was attempted: the debt stays owed and the next
      // observer asks again.
      expect(threads.createQueryBuilder).not.toHaveBeenCalled();
      expect(mentions.notify).not.toHaveBeenCalled();
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();
    });

    it('never re-fans out a thread that has already announced itself', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await service.getBySlug('hello-world', 'viewer-1');

      expect(threads.createQueryBuilder).not.toHaveBeenCalled();
      expect(mentions.notify).not.toHaveBeenCalled();
    });
  });

  describe('reviewThread', () => {
    interface UpdateQbStub {
      update: jest.Mock;
      set: jest.Mock;
      where: jest.Mock;
      execute: jest.Mock;
    }
    const updateQbStub = (affected: number): UpdateQbStub => {
      const qb: UpdateQbStub = {
        update: jest.fn(() => qb),
        set: jest.fn(() => qb),
        where: jest.fn(() => qb),
        execute: jest.fn(() => Promise.resolve({ affected })),
      };
      return qb;
    };

    const pending = (): ForumThread =>
      baseThread({ reviewState: 'pending', fannedOutAt: null });

    beforeEach(() => {
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        body: 'A guide, @ana',
        deletedAt: null,
        editedAt: null,
      });
    });

    it('approving publishes the thread and fires the fan-out it was owing', async () => {
      threads.findOne.mockResolvedValue(pending());
      threads.createQueryBuilder.mockReturnValue(updateQbStub(1));

      const dto = await service.reviewThread('hello-world', moderator, true);

      expect(dto.reviewState).toBe('approved');
      expect(dto.isPublished).toBe(true);
      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(1);
      expect(mentions.notify).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'author-1',
        NotificationType.ForumThreadReviewed,
        expect.objectContaining({ decision: 'approved' }),
      );
      // No actor argument: the bell never names which moderator decided.
      expect(notifications.create.mock.calls[0]).toHaveLength(3);
    });

    it('rejecting leaves the thread invisible and announces nothing', async () => {
      threads.findOne.mockResolvedValue(pending());

      const dto = await service.reviewThread(
        'hello-world',
        moderator,
        false,
        'Not while the report is open.',
      );

      expect(dto.reviewState).toBe('rejected');
      expect(dto.isPublished).toBe(false);
      expect(threads.createQueryBuilder).not.toHaveBeenCalled();
      expect(mentions.notify).not.toHaveBeenCalled();
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'author-1',
        NotificationType.ForumThreadReviewed,
        expect.objectContaining({
          decision: 'rejected',
          reviewNote: 'Not while the report is open.',
        }),
      );
    });

    it('approving a thread its author ALSO scheduled leaves the fan-out owed', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({
          reviewState: 'pending',
          fannedOutAt: null,
          publishedAt: new Date(Date.now() + 60_000),
        }),
      );

      const dto = await service.reviewThread('hello-world', moderator, true);

      expect(dto.reviewState).toBe('approved');
      expect(dto.isPublished).toBe(false);
      expect(mentions.notify).not.toHaveBeenCalled();
      expect(threads.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a second decision on the same thread', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ reviewState: 'approved' }),
      );

      await expect(
        service.reviewThread('hello-world', moderator, false),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('refuses a non-moderator outright', async () => {
      threads.findOne.mockResolvedValue(pending());

      await expect(
        service.reviewThread('hello-world', member, true),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('create schedule coherence', () => {
    it('refuses a thread that closes before it opens', async () => {
      const publishAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const closesAt = new Date(Date.now() + 60 * 60 * 1000);

      await expect(
        service.create('author-1', {
          title: 'Hello',
          body: 'Body',
          category: 'general',
          publishAt: publishAt.toISOString(),
          closesAt: closesAt.toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses a thread that closes at the very instant it opens', async () => {
      const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await expect(
        service.create('author-1', {
          title: 'Hello',
          body: 'Body',
          category: 'general',
          publishAt: at,
          closesAt: at,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a deadline after the scheduled publish', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      await expect(
        service.create('author-1', {
          title: 'Hello',
          body: 'Body',
          category: 'general',
          publishAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          closesAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        }),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // ENG-418: the fan-out is scoped to who can read the thread and who is shown
  // writing it
  // ---------------------------------------------------------------------------
  describe('scope-aware fan-out (ENG-418)', () => {
    interface ClaimQbStub {
      update: jest.Mock;
      set: jest.Mock;
      where: jest.Mock;
      execute: jest.Mock;
    }
    const claimQbStub = (): ClaimQbStub => {
      const claimQb: ClaimQbStub = {
        update: jest.fn((): ClaimQbStub => claimQb),
        set: jest.fn((): ClaimQbStub => claimQb),
        where: jest.fn((): ClaimQbStub => claimQb),
        execute: jest.fn(() => Promise.resolve({ affected: 1 })),
      };
      return claimQb;
    };

    const opBody = 'Come and help, @ana';

    // Opens a thread that is visible and still owes its announcement, so the
    // read path runs the whole fan-out once. A fresh row per call, because the
    // fan-out marks the in-memory row as paid.
    const openOwingThread = async (
      overrides: Partial<ForumThread> = {},
    ): Promise<void> => {
      threads.findOne.mockResolvedValue(
        baseThread({ fannedOutAt: null, ...overrides }),
      );
      threads.createQueryBuilder.mockReturnValue(claimQbStub());
      await service.getBySlug('hello-world', 'viewer-1');
    };

    const mentionPayload = (): Record<string, unknown> => {
      const [, , payload] = mentions.notify.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      return payload;
    };

    const threadCreatedEmits = (): unknown[][] =>
      (eventEmitter.emit.mock.calls as unknown[][]).filter(
        ([eventName]) => eventName === FORUM_THREAD_CREATED,
      );

    beforeEach(() => {
      profiles.find.mockResolvedValue([baseProfile()]);
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        body: opBody,
        deletedAt: null,
        editedAt: null,
      });
    });

    it('does not record profile activity for an anonymous thread', async () => {
      await openOwingThread({ isAnonymous: true });

      expect(threadCreatedEmits()).toHaveLength(0);
      // The thread is still forum-wide, so the rest of the fan-out runs.
      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(1);
    });

    it('does not record profile activity for an official thread', async () => {
      await openOwingThread({ isOfficial: true });

      expect(threadCreatedEmits()).toHaveLength(0);
    });

    it('does not record profile activity for a thread in a private community', async () => {
      // The default community probe answers "no" to both questions: the
      // viewer is not shut out, and the community is not a public top-level
      // one, which is the gated case.
      await openOwingThread({ communityId: 'community-1' });

      expect(threadCreatedEmits()).toHaveLength(0);
    });

    it('records profile activity for a named thread every member can read', async () => {
      await openOwingThread();

      expect(threadCreatedEmits()).toHaveLength(1);
      expect(threadCreatedEmits()[0]?.[1]).toEqual({
        authorId: 'author-1',
        threadSlug: 'hello-world',
        title: 'Hello world',
      });
    });

    it('links topics only for forum-wide threads', async () => {
      await openOwingThread({ communityId: 'community-1' });
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();

      // A public, top-level, live community: the first probe is the read
      // gate (not hidden), the second is the forum-wide question (yes).
      const forumWideProbe = communityAccessQbStub(true);
      threads.manager.createQueryBuilder
        .mockReturnValueOnce(communityAccessQbStub(false))
        .mockReturnValueOnce(forumWideProbe);
      await openOwingThread({ communityId: 'community-1' });
      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(1);
      expect(forumWideProbe.andWhere).toHaveBeenCalledWith(
        'com.accessTier = :publicTier',
        { publicTier: AccessTier.Public },
      );
      expect(forumWideProbe.andWhere).toHaveBeenCalledWith(
        'com.parentId IS NULL',
      );
      expect(forumWideProbe.andWhere).toHaveBeenCalledWith(
        'com.archivedAt IS NULL',
      );

      // A cross-posted thread is forum-wide by the author's choice, whatever
      // its community's tier, so no probe is needed.
      await openOwingThread({ communityId: 'community-1', crossPosted: true });
      expect(topicPostLink.linkThread).toHaveBeenCalledTimes(2);
    });

    it('omits actorId from mention payloads on an anonymous thread', async () => {
      await openOwingThread({ isAnonymous: true });

      expect(mentions.notify).toHaveBeenCalledTimes(1);
      // The real author still reaches `notify` for the block filter and the
      // self-mention skip; the payload the bell reads names nobody.
      const [, notifiedAuthorId] = mentions.notify.mock.calls[0] as [
        string,
        string,
      ];
      expect(notifiedAuthorId).toBe('author-1');
      expect(mentionPayload()).not.toHaveProperty('actorId');
      expect(mentionPayload()).toMatchObject({
        source: 'forum',
        threadSlug: 'hello-world',
      });
    });

    it('omits the mention excerpt on a gated community thread', async () => {
      await openOwingThread({ communityId: 'community-1' });

      expect(mentions.notify).toHaveBeenCalledTimes(1);
      expect(mentionPayload()).not.toHaveProperty('excerpt');
      expect(mentionPayload()).toMatchObject({
        actorId: 'author-1',
        threadSlug: 'hello-world',
      });
    });

    it('a failed forum-wide probe fans out as gated and create still resolves', async () => {
      // The probe runs after the thread has committed. A rejection must not
      // turn a posted thread into a 500 (a retry would post it twice), so it
      // answers "not forum-wide", the privacy-safe reading.
      membership.assertMemberBySlug.mockResolvedValue('community-1');
      threads.manager.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getExists: jest.fn().mockRejectedValue(new Error('pool timeout')),
      });

      await expect(
        service.create('author-1', {
          title: 'Hello, World!',
          body: opBody,
          category: 'general',
          communitySlug: 'lisbon-hikers',
        }),
      ).resolves.toBeDefined();

      expect(threadCreatedEmits()).toHaveLength(0);
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();
      expect(mentions.notify).toHaveBeenCalledTimes(1);
      expect(mentionPayload()).not.toHaveProperty('excerpt');
    });

    it('keeps the excerpt and the actor on a named forum-wide thread', async () => {
      await openOwingThread();

      expect(mentionPayload()).toEqual({
        actorId: 'author-1',
        source: 'forum',
        threadSlug: 'hello-world',
        excerpt: opBody,
      });
    });

    it('keeps an emoji at the 140-character mention excerpt boundary whole', async () => {
      const body = `${'a'.repeat(139)}${GRINNING_FACE}`;
      posts.findOne.mockResolvedValue({
        id: 'op-1',
        threadId: 'thread-1',
        authorId: 'author-1',
        body,
        deletedAt: null,
        editedAt: null,
      });

      await openOwingThread();

      expect(mentionPayload().excerpt).toBe(body);
    });
  });

  // ---------------------------------------------------------------------------
  // PRD-407: a cross-posted thread reaches the whole forum for reading
  // ---------------------------------------------------------------------------
  describe('cross-post reach (PRD-407)', () => {
    it('list admits a cross-posted thread to a non-member', async () => {
      const qb = qbStub([baseThread()]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', undefined, undefined, undefined);

      const { sql } = accessTierGateCall(qb);
      expect(sql).toContain('OR t.cross_posted = true');
    });

    it('loadOr404 serves a cross-posted gated thread to a non-member', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ communityId: 'community-1', crossPosted: true }),
      );
      // Were the community gate consulted, it would hide this thread.
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(true),
      );

      await expect(
        service.loadOr404('hello-world', 'viewer-1'),
      ).resolves.toMatchObject({ slug: 'hello-world' });
      expect(threads.manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('still hides a gated thread that is not cross-posted', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ communityId: 'community-1' }),
      );
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(true),
      );

      await expect(
        service.loadOr404('hello-world', 'viewer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a non-member still cannot reply to a cross-posted thread', async () => {
      membership.isMember.mockResolvedValue(false);

      await expect(
        service.assertCanReplyInThread(
          baseThread({ communityId: 'community-1', crossPosted: true }),
          'viewer-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(membership.isMember).toHaveBeenCalledWith(
        'community-1',
        'viewer-1',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // A community a moderator took down takes no new threads, replies or poll
  // votes from anyone but its own staff, with the board's own 404.
  // ---------------------------------------------------------------------------
  describe('taken-down community', () => {
    beforeEach(() => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });
    });

    it('assertCanReplyInThread 404s a member, reading the takedown by community slug', async () => {
      await expect(
        service.assertCanReplyInThread(
          baseThread({ communityId: 'community-1' }),
          'viewer-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(membership.slugById).toHaveBeenCalledWith('community-1');
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'community',
        'lisbon-hikers',
      );
    });

    it('assertCanReplyInThread 404s a non-member before the roster refusal', async () => {
      membership.isMember.mockResolvedValue(false);
      await expect(
        service.assertCanReplyInThread(
          baseThread({ communityId: 'community-1', crossPosted: true }),
          'viewer-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assertCanReplyInThread treats a hidden community the same as a removed one', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });
      await expect(
        service.assertCanReplyInThread(
          baseThread({ communityId: 'community-1' }),
          'viewer-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assertCanReplyInThread lets the community staff through', async () => {
      membership.isOwnerOrMod.mockResolvedValue(true);
      await expect(
        service.assertCanReplyInThread(
          baseThread({ communityId: 'community-1' }),
          'mod-1',
        ),
      ).resolves.toBeUndefined();
      expect(membership.isOwnerOrMod).toHaveBeenCalledWith(
        'community-1',
        'mod-1',
      );
    });

    it('assertCanReplyInThread leaves a thread outside any community alone', async () => {
      await expect(
        service.assertCanReplyInThread(baseThread(), 'viewer-1'),
      ).resolves.toBeUndefined();
      expect(contentModeration.stateFor).not.toHaveBeenCalled();
    });

    it('create 404s a member starting a thread in the community', async () => {
      membership.assertMemberBySlug.mockResolvedValue('community-1');
      await expect(
        service.create('author-1', {
          title: 'Hello, World!',
          body: 'First post body',
          category: 'general',
          communitySlug: 'lisbon-hikers',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'community',
        'lisbon-hikers',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('create lets the community staff start a thread', async () => {
      membership.assertMemberBySlug.mockResolvedValue('community-1');
      membership.isOwnerOrMod.mockResolvedValue(true);
      profiles.find.mockResolvedValue([baseProfile()]);
      await expect(
        service.create('author-1', {
          title: 'Hello, World!',
          body: 'First post body',
          category: 'general',
          communitySlug: 'lisbon-hikers',
        }),
      ).resolves.toBeDefined();
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // PRD-408: the co-author credit
  // ---------------------------------------------------------------------------
  describe('co-author credit (PRD-408)', () => {
    it('refuses a co-author who blocked the author with the unknown-handle message', async () => {
      // `MemberLookup.userIdsForSlugs` resolves the handle through a profile
      // query builder: the handle names a real, active member.
      interface HandleQbStub {
        innerJoin: jest.Mock;
        where: jest.Mock;
        getMany: jest.Mock;
      }
      const handleQb: HandleQbStub = {
        innerJoin: jest.fn((): HandleQbStub => handleQb),
        where: jest.fn((): HandleQbStub => handleQb),
        getMany: jest.fn((): Promise<Profile[]> =>
          Promise.resolve([baseProfile({ userId: 'bea-1', slug: 'bea' })]),
        ),
      };
      Object.assign(profiles, { createQueryBuilder: jest.fn(() => handleQb) });
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      const attempt = service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        coAuthorHandle: 'bea',
      });

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(
        'No member with that handle to credit as co-author',
      );
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        'author-1',
        'bea-1',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('the credited member can remove their credit', async () => {
      threads.findOne.mockResolvedValue(baseThread({ coAuthorId: 'member-1' }));

      const echo = await service.removeCoAuthor('hello-world', member);

      expect(threads.update).toHaveBeenCalledWith(
        { id: 'thread-1' },
        { coAuthorId: null },
      );
      expect(echo.coAuthor).toBeNull();
      expect(echo.viewerIsCoAuthor).toBe(false);
    });

    it('the author can retract the credit', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ authorId: 'member-1', coAuthorId: 'bea-1' }),
      );

      await service.removeCoAuthor('hello-world', member);

      expect(threads.update).toHaveBeenCalledWith(
        { id: 'thread-1' },
        { coAuthorId: null },
      );
    });

    it('a third member gets 404 removing a credit', async () => {
      threads.findOne.mockResolvedValue(baseThread({ coAuthorId: 'bea-1' }));

      await expect(
        service.removeCoAuthor('hello-world', member),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(threads.update).not.toHaveBeenCalled();
    });

    // `MemberLookup.userIdForSlug` resolves the handle through a profile
    // query builder: the handle names a real, active member.
    const stubCoAuthorHandle = (): void => {
      interface HandleQbStub {
        innerJoin: jest.Mock;
        where: jest.Mock;
        getMany: jest.Mock;
      }
      const handleQb: HandleQbStub = {
        innerJoin: jest.fn((): HandleQbStub => handleQb),
        where: jest.fn((): HandleQbStub => handleQb),
        getMany: jest.fn((): Promise<Profile[]> =>
          Promise.resolve([baseProfile({ userId: 'bea-1', slug: 'bea' })]),
        ),
      };
      Object.assign(profiles, { createQueryBuilder: jest.fn(() => handleQb) });
    };

    const coAuthorNoticeCalls = (): unknown[][] =>
      (notifications.create.mock.calls as unknown[][]).filter(
        ([, type]) => type === NotificationType.ForumCoAuthorCredit,
      );

    it('tells the credited member on create, naming the author', async () => {
      stubCoAuthorHandle();

      await service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        coAuthorHandle: 'bea',
      });

      expect(coAuthorNoticeCalls()).toHaveLength(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'bea-1',
        NotificationType.ForumCoAuthorCredit,
        {
          source: 'forum',
          threadSlug: expect.any(String) as unknown,
          threadTitle: 'A guide',
          actorId: 'author-1',
        },
      );
      // No `actorId` ARGUMENT: that would add the mute gate, and a mute must
      // not silence the consent notice. The payload still names the author.
      expect(coAuthorNoticeCalls()[0]).toHaveLength(3);
      expect(mentions.forumThreadAudience).toHaveBeenCalledWith(
        expect.any(String),
        ['bea-1'],
      );
    });

    it('tells nobody while the credited thread is still scheduled', async () => {
      stubCoAuthorHandle();

      await service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        coAuthorHandle: 'bea',
        publishAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      expect(coAuthorNoticeCalls()).toHaveLength(0);
    });

    it('tells the co-author when a deferred thread goes live, leaving a masked author unnamed', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({
          fannedOutAt: null,
          coAuthorId: 'bea-1',
          isAnonymous: true,
        }),
      );
      // The claim `publishThread` issues: one affected row, so this read is
      // the one that pays the fan-out.
      interface UpdateQbStub {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        execute: jest.Mock;
      }
      const claimQb: UpdateQbStub = {
        update: jest.fn((): UpdateQbStub => claimQb),
        set: jest.fn((): UpdateQbStub => claimQb),
        where: jest.fn((): UpdateQbStub => claimQb),
        execute: jest.fn(() => Promise.resolve({ affected: 1 })),
      };
      threads.createQueryBuilder.mockReturnValue(claimQb);

      await service.getBySlug('hello-world', 'viewer-1');

      expect(notifications.create).toHaveBeenCalledWith(
        'bea-1',
        NotificationType.ForumCoAuthorCredit,
        {
          source: 'forum',
          threadSlug: 'hello-world',
          threadTitle: 'Hello world',
        },
      );
    });

    it('refuses a co-author off a gated community roster with the unknown-handle message', async () => {
      stubCoAuthorHandle();
      membership.assertMemberBySlug.mockResolvedValue('community-1');
      // `isCommunityHiddenFrom`: the community is gated and the co-author is
      // not on its roster.
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(true),
      );

      const attempt = service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        communitySlug: 'lisbon-hikers',
        coAuthorHandle: 'bea',
      });

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(
        'No member with that handle to credit as co-author',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('accepts a co-author off the roster when the thread is cross-posted', async () => {
      stubCoAuthorHandle();
      membership.assertMemberBySlug.mockResolvedValue('community-1');
      threads.manager.createQueryBuilder.mockReturnValue(
        communityAccessQbStub(true),
      );

      await service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        communitySlug: 'lisbon-hikers',
        crossPosted: true,
        coAuthorHandle: 'bea',
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('accepts a co-author on the gated community roster', async () => {
      stubCoAuthorHandle();
      membership.assertMemberBySlug.mockResolvedValue('community-1');

      await service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        communitySlug: 'lisbon-hikers',
        coAuthorHandle: 'bea',
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('tells a co-author who cannot read the thread nothing', async () => {
      stubCoAuthorHandle();
      mentions.forumThreadAudience.mockResolvedValue(new Set<string>());

      await service.create('author-1', {
        title: 'A guide',
        body: 'Body',
        category: 'general',
        coAuthorHandle: 'bea',
      });

      expect(coAuthorNoticeCalls()).toHaveLength(0);
    });

    it('a failed notice never fails the create', async () => {
      stubCoAuthorHandle();
      notifications.create.mockRejectedValue(new Error('enum label missing'));

      await expect(
        service.create('author-1', {
          title: 'A guide',
          body: 'Body',
          category: 'general',
          coAuthorHandle: 'bea',
        }),
      ).resolves.toBeDefined();
    });

    it('leaves the co-author off the byline for a viewer with a block with them', async () => {
      threads.findOne.mockResolvedValue(baseThread({ coAuthorId: 'bea-1' }));
      profiles.find.mockResolvedValue([
        baseProfile(),
        baseProfile({ userId: 'bea-1', slug: 'bea', firstName: 'Bea' }),
      ]);
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['bea-1']));

      const res = await service.getBySlug('hello-world', 'viewer-1');

      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('viewer-1', [
        'bea-1',
      ]);
      expect(res.coAuthor).toBeNull();
      expect(res.author.handle).toBe('ava');
    });

    it('shows the co-author to a viewer with no block', async () => {
      threads.findOne.mockResolvedValue(baseThread({ coAuthorId: 'bea-1' }));
      profiles.find.mockResolvedValue([
        baseProfile(),
        baseProfile({ userId: 'bea-1', slug: 'bea', firstName: 'Bea' }),
      ]);

      const res = await service.getBySlug('hello-world', 'viewer-1');

      expect(res.coAuthor).toEqual(expect.objectContaining({ handle: 'bea' }));
    });

    it('filters co-authors across a page with ONE block read', async () => {
      const qb = qbStub([
        baseThread({ id: 'thread-1', slug: 'one', coAuthorId: 'bea-1' }),
        baseThread({ id: 'thread-2', slug: 'two', coAuthorId: 'cai-1' }),
        baseThread({ id: 'thread-3', slug: 'three' }),
      ]);
      threads.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([
        baseProfile(),
        baseProfile({ userId: 'bea-1', slug: 'bea' }),
        baseProfile({ userId: 'cai-1', slug: 'cai' }),
      ]);
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['bea-1']));

      const page = await service.list(
        'viewer-1',
        undefined,
        undefined,
        undefined,
      );

      expect(blockFilter.blockedUserIds).toHaveBeenCalledTimes(1);
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('viewer-1', [
        'bea-1',
        'cai-1',
      ]);
      expect(
        page.data.map((thread) => thread.coAuthor?.handle ?? null),
      ).toEqual([null, 'cai', null]);
    });

    it('404s removing a credit from a withdrawn thread', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ coAuthorId: 'member-1', deletedAt: new Date() }),
      );

      await expect(
        service.removeCoAuthor('hello-world', member),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(threads.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PRD-409: the read watermark records what the member saw
  // ---------------------------------------------------------------------------
  describe('read watermark upTo (PRD-409)', () => {
    it('markRead clamps upTo to now', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await service.markRead('hello-world', member, nextWeek.toISOString());
      const afterCall = Date.now();

      const [, , readAt] = subscriptions.markRead.mock.calls[0] as [
        string,
        string,
        Date,
      ];
      expect(readAt.getTime()).toBeLessThanOrEqual(afterCall);
      expect(readAt.getTime()).toBeLessThan(nextWeek.getTime());
    });

    it('markRead stamps a past upTo exactly', async () => {
      threads.findOne.mockResolvedValue(baseThread());
      const upTo = '2026-09-01T10:00:00.000Z';

      await service.markRead('hello-world', member, upTo);

      expect(subscriptions.markRead).toHaveBeenCalledWith(
        'thread-1',
        'member-1',
        new Date(upTo),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // ENG-423: a deadline's one-year cap runs from publication
  // ---------------------------------------------------------------------------
  describe('deadline window (ENG-423)', () => {
    const dayMs = 24 * 60 * 60 * 1000;

    it('closesAt is measured from a scheduled publishAt', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);
      const publishAt = new Date(Date.now() + 300 * dayMs);
      // More than a year from now, less than a year after publication.
      const closesAt = new Date(Date.now() + 400 * dayMs);

      await expect(
        service.create('author-1', {
          title: 'Hello',
          body: 'Body',
          category: 'general',
          publishAt: publishAt.toISOString(),
          closesAt: closesAt.toISOString(),
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a closesAt more than a year after a scheduled publishAt', async () => {
      const publishAt = new Date(Date.now() + 30 * dayMs);
      const closesAt = new Date(publishAt.getTime() + 366 * dayMs);

      await expect(
        service.create('author-1', {
          title: 'Hello',
          body: 'Body',
          category: 'general',
          publishAt: publishAt.toISOString(),
          closesAt: closesAt.toISOString(),
        }),
      ).rejects.toThrow(
        'closesAt must be at most a year after the thread is published',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('holds a poll deadline to the same window', async () => {
      const publishAt = new Date(Date.now() + 30 * dayMs);
      const pollClosesAt = new Date(publishAt.getTime() + 366 * dayMs);

      await expect(
        service.create('author-1', {
          title: 'Hello',
          body: 'Body',
          category: 'general',
          publishAt: publishAt.toISOString(),
          poll: {
            options: [{ label: 'Yes' }, { label: 'No' }],
            closesAt: pollClosesAt.toISOString(),
          },
        }),
      ).rejects.toThrow(
        'poll.closesAt must be at most a year after the thread is published',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // PRD-461 follow-up: each review queue row names its community
  // ---------------------------------------------------------------------------
  describe('listPendingReview community', () => {
    it('names the community on a community thread and null on a global one', async () => {
      threads.createQueryBuilder.mockReturnValue(
        qbStub([
          baseThread({
            id: 'thread-1',
            reviewState: 'pending',
            communityId: 'community-1',
          }),
          baseThread({
            id: 'thread-2',
            slug: 'global-thread',
            reviewState: 'pending',
            communityId: null,
          }),
        ]),
      );
      threads.manager.find.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Community
            ? [
                {
                  id: 'community-1',
                  slug: 'lisbon-hikers',
                  name: 'Lisbon Hikers',
                },
              ]
            : [],
        ),
      );

      const page = await service.listPendingReview(moderator, undefined, 20);

      expect(page.data.map((row) => [row.id, row.community])).toEqual([
        ['thread-1', { slug: 'lisbon-hikers', name: 'Lisbon Hikers' }],
        ['thread-2', null],
      ]);
      // One batched community read covers the whole page.
      const communityReads = (
        threads.manager.find.mock.calls as unknown[][]
      ).filter((call: unknown[]) => call[0] === Community);
      expect(communityReads).toHaveLength(1);
      expect(communityReads[0]?.[1]).toEqual({
        where: { id: In(['community-1']) },
        select: { id: true, slug: true, name: true },
      });
    });

    it('skips the community read when no queued thread has a community', async () => {
      threads.createQueryBuilder.mockReturnValue(
        qbStub([baseThread({ reviewState: 'pending', communityId: null })]),
      );

      const page = await service.listPendingReview(moderator, undefined, 20);

      expect(page.data[0]?.community).toBeNull();
      expect(
        threads.manager.find.mock.calls.some(
          (call: unknown[]) => call[0] === Community,
        ),
      ).toBe(false);
    });
  });

  describe('funding: open calls (P2)', () => {
    it('resolves the funding object up front and inserts it inside the create transaction', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedCall);
      funding.insertForThread.mockResolvedValue(makeFundingRow());
      profiles.find.mockResolvedValue([baseProfile()]);

      const response = await service.create('author-1', {
        title: 'Arts grant',
        body: 'Applications close in December',
        category: 'funding',
        kind: 'call',
        funding: callFunding,
      });

      expect(funding.resolveForCreate).toHaveBeenCalledWith({
        kind: 'call',
        category: 'funding',
        title: 'Arts grant',
        body: 'Applications close in December',
        isAnonymous: false,
        funding: callFunding,
      });
      expect(funding.insertForThread).toHaveBeenCalledWith(
        manager,
        'thread-1',
        resolvedCall,
        expect.any(Date),
      );
      expect(response.funding).toEqual(
        expect.objectContaining({
          linkHost: 'gulbenkian.pt',
          funderName: 'Fundação Gulbenkian',
          callState: 'closing',
          askState: null,
        }),
      );
    });

    it('puts the server-owned open-call tag first on a call', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedCall);
      funding.insertForThread.mockResolvedValue(makeFundingRow());
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.create('author-1', {
        title: 'Arts grant',
        body: 'Applications close in December',
        category: 'funding',
        kind: 'call',
        tags: ['grants', 'fund', 'arts', 'lisbon', 'film'],
        funding: callFunding,
      });

      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      expect(threadsRepositoryInTransaction.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['open-call', 'grants', 'fund', 'arts', 'lisbon'],
        }),
      );
    });

    it('strips open-call from every other kind', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.create('author-1', {
        title: 'Where do people find arts grants?',
        body: 'Any tips for a first application?',
        category: 'funding',
        kind: 'question',
        tags: ['open-call', 'grants'],
      });

      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      expect(threadsRepositoryInTransaction.save).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['grants'] }),
      );
      expect(funding.insertForThread).not.toHaveBeenCalled();
    });

    it('refuses a call before any insert when the funding rules reject it', async () => {
      funding.resolveForCreate.mockImplementation(() => {
        throw fundingException('funding_kind_category_mismatch');
      });

      expect(
        await fundingCodeOf(
          service.create('author-1', {
            title: 'Arts grant',
            body: 'Applications close in December',
            category: 'activism',
            kind: 'call',
            funding: callFunding,
          }),
        ),
      ).toBe('funding_kind_category_mismatch');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses to move a call out of the funding category, for a moderator too', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'call', category: 'funding' }),
      );

      expect(
        await fundingCodeOf(
          service.updateThread(
            'hello-world',
            moderator,
            undefined,
            undefined,
            'activism',
          ),
        ),
      ).toBe('funding_kind_category_mismatch');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('lets a moderator file an ordinary thread under funding', async () => {
      threads.findOne.mockResolvedValue(baseThread());

      await service.updateThread(
        'hello-world',
        moderator,
        undefined,
        undefined,
        'funding',
      );

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'funding' }),
      );
    });

    it('replaces the funding details inside the edit transaction and announces a moved deadline after it commits', async () => {
      const thread = baseThread({
        kind: 'call',
        category: 'funding',
        authorId: 'member-1',
      });
      threads.findOne.mockResolvedValue(thread);
      const prepared = {
        threadId: 'thread-1',
        resolved: resolvedCall,
        previousDeadline: new Date('2026-11-01T23:59:00.000Z'),
        isDeadlineChanged: true,
      };
      funding.prepareEdit.mockResolvedValue(prepared);
      funding.rowsByThread.mockResolvedValue(
        new Map([['thread-1', makeFundingRow()]]),
      );
      const writeOrder: string[] = [];
      funding.saveEdit.mockImplementation(() => {
        writeOrder.push('saveEdit');
        return Promise.resolve();
      });
      funding.emitDeadlineChanged.mockImplementation(() => {
        writeOrder.push('emitDeadlineChanged');
      });

      const response = await service.updateThread(
        'hello-world',
        member,
        undefined,
        undefined,
        undefined,
        callFunding,
      );

      expect(funding.prepareEdit).toHaveBeenCalledWith(thread, callFunding);
      expect(funding.saveEdit).toHaveBeenCalledWith(manager, prepared);
      expect(funding.emitDeadlineChanged).toHaveBeenCalledWith(
        thread,
        prepared,
        'member-1',
      );
      expect(writeOrder).toEqual(['saveEdit', 'emitDeadlineChanged']);
      expect(response.funding?.funderName).toBe('Fundação Gulbenkian');
    });

    it('refuses a funding edit from a member who neither wrote nor moderates the thread', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'call', category: 'funding' }),
      );

      await expect(
        service.updateThread(
          'hello-world',
          member,
          undefined,
          undefined,
          undefined,
          callFunding,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(funding.prepareEdit).not.toHaveBeenCalled();
    });

    it('maps the funding row on the detail read', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'call', category: 'funding' }),
      );
      funding.rowsByThread.mockResolvedValue(
        new Map([['thread-1', makeFundingRow()]]),
      );

      const response = await service.getBySlug('hello-world', 'viewer-1');

      expect(funding.rowsByThread).toHaveBeenCalledWith(['thread-1']);
      expect(response.funding?.callState).toBe('closing');
    });

    it('reads a whole page of funding rows in one batch', async () => {
      threads.createQueryBuilder.mockReturnValue(
        qbStub([
          baseThread({ kind: 'call', category: 'funding' }),
          baseThread({ id: 'thread-2', slug: 'second' }),
        ]),
      );
      funding.rowsByThread.mockResolvedValue(
        new Map([['thread-1', makeFundingRow()]]),
      );

      const page = await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
      );

      expect(funding.rowsByThread).toHaveBeenCalledTimes(1);
      expect(funding.rowsByThread).toHaveBeenCalledWith([
        'thread-1',
        'thread-2',
      ]);
      expect(page.data[0]?.funding).not.toBeNull();
      expect(page.data[1]?.funding).toBeNull();
    });
  });

  describe('funding views and lookup (P2)', () => {
    function andWhereSql(qb: QbStub): string[] {
      return qb.andWhere.mock.calls.map((call) => String(call[0]));
    }

    function andWhereParameters(qb: QbStub): Record<string, unknown> {
      return Object.assign(
        {},
        ...qb.andWhere.mock.calls.map(
          (call) => (call[1] ?? {}) as Record<string, unknown>,
        ),
      ) as Record<string, unknown>;
    }

    it('lists open calls by deadline with rolling calls last, pinned ones included, capped at 100', async () => {
      const qb = qbStub([baseThread({ kind: 'call', category: 'funding' })]);
      threads.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'open' },
      );

      expect(qb.innerJoin).toHaveBeenCalledWith(
        ForumThreadFunding,
        'funding',
        '"funding"."thread_id" = "t"."id"',
      );
      expect(andWhereSql(qb)).not.toContain('t.is_pinned = false');
      expect(andWhereSql(qb)).toContain('"t"."kind" = :fundingKind');
      expect(andWhereParameters(qb)).toEqual(
        expect.objectContaining({ fundingKind: 'call' }),
      );
      expect(
        andWhereSql(qb).some((sql) =>
          sql.includes('"funding"."deadline" >= :fundingNow'),
        ),
      ).toBe(true);
      expect(qb.orderBy).toHaveBeenCalledWith(
        '"funding"."deadline"',
        'ASC',
        'NULLS LAST',
      );
      expect(qb.limit).toHaveBeenCalledWith(101);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
      expect(page.data).toHaveLength(1);
    });

    it('lists calls closing within seven days', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'closing' },
      );

      const parameters = andWhereParameters(qb);
      const fundingNow = parameters.fundingNow as Date;
      const closingUntil = parameters.closingUntil as Date;
      expect(closingUntil.getTime() - fundingNow.getTime()).toBe(
        CALL_CLOSING_WINDOW_MS,
      );
      expect(qb.orderBy).toHaveBeenCalledWith('"funding"."deadline"', 'ASC');
    });

    it('lists approved, live fundraisers newest approval first and ignores call filters', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'asks', eligibility: ['students'], scope: 'eu' },
      );

      expect(andWhereSql(qb)).toEqual(
        expect.arrayContaining([
          '"t"."kind" = :fundingKind',
          '"t"."review_state" = :approvedReview',
          '"t"."author_id" IS NOT NULL',
          '"funding"."ended_at" IS NULL',
        ]),
      );
      expect(andWhereParameters(qb)).toEqual(
        expect.objectContaining({
          fundingKind: 'ask',
          approvedReview: 'approved',
        }),
      );
      expect(andWhereSql(qb).some((sql) => sql.includes('eligibility'))).toBe(
        false,
      );
      expect(qb.orderBy).toHaveBeenCalledWith(
        '"funding"."approved_at"',
        'DESC',
        'NULLS LAST',
      );
    });

    it.each(['open', 'closing', 'asks'] as const)(
      'leaves a %s row out when a moderator took its opening post down',
      async (view) => {
        const qb = qbStub([]);
        threads.createQueryBuilder.mockReturnValue(qb);

        await service.list(
          'viewer-1',
          'funding',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          { view },
        );

        const takedownSql = forumOpNotTakenDownSql('"t"');
        expect(andWhereSql(qb)).toContain(takedownSql);
        expect(takedownSql).toContain('NOT EXISTS');
        expect(takedownSql).toContain('"op"."thread_id" = "t"."id"');
        expect(takedownSql).toContain('"op"."is_op" = true');
        expect(takedownSql).toContain(
          '"moderation"."subject_type" IN (\'post\', \'reply\')',
        );
        expect(takedownSql).toContain(
          '("moderation"."hidden_at" IS NOT NULL OR "moderation"."removed_at" IS NOT NULL)',
        );
      },
    );

    it('narrows open calls by eligibility (any of) and scope', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'open', eligibility: ['students', 'collectives'], scope: 'eu' },
      );

      expect(andWhereSql(qb)).toEqual(
        expect.arrayContaining([
          '"funding"."eligibility" && CAST(:fundingEligibility AS text[])',
          '"funding"."scope" = :fundingScope',
        ]),
      );
      expect(andWhereParameters(qb)).toEqual(
        expect.objectContaining({
          fundingEligibility: ['students', 'collectives'],
          fundingScope: 'eu',
        }),
      );
    });

    it('says there is more when the cap is exceeded', async () => {
      const qb = qbStub(
        Array.from({ length: 101 }, (_, index) =>
          baseThread({ id: `thread-${index}`, slug: `call-${index}` }),
        ),
      );
      threads.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'open' },
      );

      expect(page.data).toHaveLength(100);
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: true });
    });

    it('lists the discussion view through the ordinary cursor', async () => {
      const qb = qbStub([baseThread({ category: 'funding' })]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'discussion' },
      );

      expect(qb.innerJoin).not.toHaveBeenCalled();
      expect(andWhereSql(qb)).toContain('t.is_pinned = false');
      expect(
        andWhereSql(qb).some((sql) =>
          sql.includes('NOT EXISTS (SELECT 1 FROM "forum_thread_funding"'),
        ),
      ).toBe(true);
    });

    it('ignores a funding view outside the funding category', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        'activism',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'open' },
      );

      expect(qb.innerJoin).not.toHaveBeenCalled();
      expect(andWhereSql(qb)).toContain('t.is_pinned = false');
    });

    it('finds the newest visible open call for a tracking-tagged spelling of its link', async () => {
      const qb = qbStub([
        baseThread({
          kind: 'call',
          category: 'funding',
          slug: 'arts-grant',
          title: 'Arts grant',
        }),
      ]);
      threads.createQueryBuilder.mockReturnValue(qb);
      funding.rowsByThread.mockResolvedValue(
        new Map([
          [
            'thread-1',
            makeFundingRow({ deadline: new Date('2026-12-01T23:59:00.000Z') }),
          ],
        ]),
      );

      const match = await service.findOpenCallByLink(
        'viewer-1',
        'https://www.Gulbenkian.pt/bolsas/arte-queer/?utm_source=newsletter#apply',
      );

      expect(andWhereParameters(qb)).toEqual(
        expect.objectContaining({
          fundingLinkKey: 'gulbenkian.pt/bolsas/arte-queer',
        }),
      );
      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"t"."author_id"',
      );
      accessTierGateCall(qb);
      expect(andWhereSql(qb)).toEqual(
        expect.arrayContaining([
          't.deleted_at IS NULL',
          FORUM_THREAD_VISIBLE_SQL,
          forumOpNotTakenDownSql('"t"'),
        ]),
      );
      expect(match).toEqual({
        slug: 'arts-grant',
        title: 'Arts grant',
        deadline: '2026-12-01T23:59:00.000Z',
      });
    });

    it('answers null without a query for a link that is not https', async () => {
      expect(
        await service.findOpenCallByLink('viewer-1', 'http://gulbenkian.pt/x'),
      ).toBeNull();
      expect(threads.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('answers null when no visible open call uses the link', async () => {
      threads.createQueryBuilder.mockReturnValue(qbStub([]));

      expect(
        await service.findOpenCallByLink(
          'viewer-1',
          'https://www.gulbenkian.pt/bolsas/arte-queer',
        ),
      ).toBeNull();
      expect(funding.rowsByThread).not.toHaveBeenCalled();
    });
  });

  describe('funding: fundraisers (P4)', () => {
    const askRowOverrides: Partial<ForumThreadFunding> = {
      linkUrl: 'https://www.gofundme.com/f/help-ana',
      linkKey: 'gofundme.com/f/help-ana',
      funderName: null,
      amountMax: null,
      deadline: null,
      eligibility: [],
      scope: null,
      goalAmount: 1200,
      askPurpose: 'healthcare',
      beneficiary: 'self',
    };
    const resolvedAsk: ResolvedFundingFields = {
      ...resolvedCall,
      kind: 'ask',
      linkUrl: 'https://www.gofundme.com/f/help-ana',
      linkHost: 'gofundme.com',
      linkKey: 'gofundme.com/f/help-ana',
      funderName: null,
      deadline: null,
      eligibility: [],
      scope: null,
      goalAmount: 1200,
      askPurpose: 'healthcare',
      beneficiary: 'self',
    };
    const askFunding: CreateThreadFundingDto = {
      linkUrl: 'https://www.gofundme.com/f/help-ana',
      goalAmount: 1200,
      askPurpose: 'healthcare',
      beneficiary: 'self',
    };
    const storedOpBody = 'Everything is explained on the GoFundMe page.';
    const storedOp = {
      id: 'post-1',
      threadId: 'thread-1',
      authorId: 'member-1',
      body: storedOpBody,
      isOp: true,
      editedAt: null,
      deletedAt: null,
    };

    function andWhereSql(qb: QbStub): string[] {
      return qb.andWhere.mock.calls.map((call) => String(call[0]));
    }

    function andWhereParameters(qb: QbStub): Record<string, unknown> {
      return Object.assign(
        {},
        ...qb.andWhere.mock.calls.map(
          (call) => (call[1] ?? {}) as Record<string, unknown>,
        ),
      ) as Record<string, unknown>;
    }

    it('holds every new ask for review and defers its announcement', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedAsk);
      funding.insertForThread.mockResolvedValue(
        makeFundingRow(askRowOverrides),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      const response = await service.create('author-1', {
        title: 'Help with surgery costs',
        body: storedOpBody,
        category: 'funding',
        kind: 'ask',
        funding: askFunding,
        submitForReview: false,
      });

      expect(funding.assertCanPostAsk).toHaveBeenCalledWith('author-1');
      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      expect(threadsRepositoryInTransaction.save).toHaveBeenCalledWith(
        expect.objectContaining({ reviewState: 'pending', fannedOutAt: null }),
      );
      expect(funding.assertAskLimit).toHaveBeenCalledWith(
        manager,
        'author-1',
        'thread-1',
        expect.any(Date),
      );
      expect(topicPostLink.linkThread).not.toHaveBeenCalled();
      expect(response.reviewState).toBe('pending');
      expect(response.funding?.askState).toBe('pending');
    });

    it('coerces the official byline off an ask, even for an admin', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedAsk);
      funding.insertForThread.mockResolvedValue(
        makeFundingRow(askRowOverrides),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      const response = await service.create(
        'author-1',
        {
          title: 'Help with surgery costs',
          body: storedOpBody,
          category: 'funding',
          kind: 'ask',
          funding: askFunding,
          isOfficial: true,
        },
        false,
        true,
      );

      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      expect(threadsRepositoryInTransaction.save).toHaveBeenCalledWith(
        expect.objectContaining({ isOfficial: false }),
      );
      expect(response.author).toEqual(
        expect.objectContaining({ handle: 'ava', displayName: 'Ava Lee' }),
      );
    });

    it('refuses the official byline on an ask with a coded 400 and writes nothing', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'ask', category: 'funding', isOfficial: false }),
      );

      expect(
        await fundingCodeOf(service.setOfficial('hello-world', admin, true)),
      ).toBe('funding_ask_not_anonymous');
      expect(threads.save).not.toHaveBeenCalled();
    });

    it('still lets an admin clear the official byline on an ask', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'ask', category: 'funding', isOfficial: true }),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.setOfficial('hello-world', admin, false);

      const [saved] = threads.save.mock.calls[0] as [ForumThread];
      expect(saved.isOfficial).toBe(false);
    });

    it('counts the limit on the create transaction after the pending insert, at the default isolation level', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedAsk);
      funding.insertForThread.mockResolvedValue(
        makeFundingRow(askRowOverrides),
      );
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.create('author-1', {
        title: 'Help with surgery costs',
        body: storedOpBody,
        category: 'funding',
        kind: 'ask',
        funding: askFunding,
      });

      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      const [threadInsertOrder] =
        threadsRepositoryInTransaction.save.mock.invocationCallOrder;
      const [fundingInsertOrder] =
        funding.insertForThread.mock.invocationCallOrder;
      const [limitCheckOrder] = funding.assertAskLimit.mock.invocationCallOrder;
      expect(threadInsertOrder).toBeLessThan(limitCheckOrder ?? 0);
      expect(fundingInsertOrder).toBeLessThan(limitCheckOrder ?? 0);
      // The callback alone, with no isolation level: Postgres's READ COMMITTED
      // default, which the advisory-lock count depends on.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      const transactionArguments = dataSource.transaction.mock
        .calls[0] as unknown[];
      expect(transactionArguments).toHaveLength(1);
      expect(typeof transactionArguments[0]).toBe('function');
    });

    it('lets the limit refusal escape the create transaction', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedAsk);
      funding.insertForThread.mockResolvedValue(
        makeFundingRow(askRowOverrides),
      );
      funding.assertAskLimit.mockRejectedValue(
        fundingException('funding_ask_limit_reached'),
      );

      expect(
        await fundingCodeOf(
          service.create('author-1', {
            title: 'Help with surgery costs',
            body: storedOpBody,
            category: 'funding',
            kind: 'ask',
            funding: askFunding,
          }),
        ),
      ).toBe('funding_ask_limit_reached');
      expect(subscriptions.subscribeQuietly).not.toHaveBeenCalled();
    });

    it('refuses a poster below phone level before anything is written', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedAsk);
      funding.assertCanPostAsk.mockRejectedValue(
        fundingException('funding_ask_verification_required'),
      );

      expect(
        await fundingCodeOf(
          service.create('author-1', {
            title: 'Help with surgery costs',
            body: storedOpBody,
            category: 'funding',
            kind: 'ask',
            funding: askFunding,
          }),
        ),
      ).toBe('funding_ask_verification_required');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('leaves calls and ordinary threads free of the ask gates', async () => {
      funding.resolveForCreate.mockReturnValue(resolvedCall);
      funding.insertForThread.mockResolvedValue(makeFundingRow());
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.create('author-1', {
        title: 'Arts grant',
        body: 'Applications close in December',
        category: 'funding',
        kind: 'call',
        funding: callFunding,
      });

      expect(funding.assertCanPostAsk).not.toHaveBeenCalled();
      expect(funding.assertAskLimit).not.toHaveBeenCalled();
    });

    it('stamps the approval date on the approving transaction', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({
          kind: 'ask',
          category: 'funding',
          reviewState: 'pending',
        }),
      );

      const response = await service.reviewThread(
        'hello-world',
        moderator,
        true,
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'thread-1', reviewState: 'approved' }),
      );
      expect(funding.markAskApproved).toHaveBeenCalledWith(
        manager,
        'thread-1',
        expect.any(Date),
      );
      const [verdictSaveOrder] = manager.save.mock.invocationCallOrder;
      const [approvalDateOrder] =
        funding.markAskApproved.mock.invocationCallOrder;
      expect(verdictSaveOrder).toBeLessThan(approvalDateOrder ?? 0);
      // The verdict no longer goes through the bare repository, outside the
      // transaction.
      expect(threads.save).not.toHaveBeenCalled();
      expect(response.reviewState).toBe('approved');
    });

    it('stamps nothing on a rejection or on another kind', async () => {
      threads.findOne
        .mockResolvedValueOnce(
          baseThread({
            kind: 'ask',
            category: 'funding',
            reviewState: 'pending',
          }),
        )
        .mockResolvedValueOnce(
          baseThread({ kind: 'guide', reviewState: 'pending' }),
        );

      await service.reviewThread('hello-world', moderator, false);
      await service.reviewThread('hello-world', moderator, true);

      expect(funding.markAskApproved).not.toHaveBeenCalled();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ reviewState: 'rejected' }),
      );
    });

    it('sends an approved ask back to review when its author edits the tags, and the echo says so', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'member-1',
        reviewState: 'approved',
      });
      threads.findOne.mockResolvedValue(thread);
      funding.sendBackToReview.mockImplementation(
        (_manager: unknown, target: ForumThread) => {
          target.reviewState = 'pending';
          return Promise.resolve(true);
        },
      );

      const response = await service.updateThread(
        'hello-world',
        member,
        undefined,
        ['surgery'],
      );

      expect(funding.sendBackToReview).toHaveBeenCalledWith(
        manager,
        thread,
        false,
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ reviewState: 'pending' }),
      );
      expect(response.reviewState).toBe('pending');
      expect(response.isPublished).toBe(false);
      expect(isThreadPublished(thread)).toBe(false);
    });

    it('sends an approved ask back to review when its author edits the title', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'member-1',
        reviewState: 'approved',
      });
      threads.findOne.mockResolvedValue(thread);
      posts.findOne.mockResolvedValue({ ...storedOp });

      await service.updateThread(
        'hello-world',
        member,
        'Help with surgery costs in November',
      );

      expect(funding.sendBackToReview).toHaveBeenCalledWith(
        manager,
        thread,
        false,
      );
    });

    it('sends an approved ask back to review when its author edits the funding details, after the new details are written', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'member-1',
        reviewState: 'approved',
      });
      threads.findOne.mockResolvedValue(thread);
      const prepared = {
        threadId: 'thread-1',
        resolved: resolvedAsk,
        previousDeadline: null,
        isDeadlineChanged: false,
      };
      funding.prepareEdit.mockResolvedValue(prepared);

      await service.updateThread(
        'hello-world',
        member,
        undefined,
        undefined,
        undefined,
        askFunding,
      );

      expect(funding.sendBackToReview).toHaveBeenCalledWith(
        manager,
        thread,
        false,
      );
      const [fundingWriteOrder] = funding.saveEdit.mock.invocationCallOrder;
      const [sendBackOrder] = funding.sendBackToReview.mock.invocationCallOrder;
      expect(fundingWriteOrder).toBeLessThan(sendBackOrder ?? 0);
    });

    it('tells the funding rules when a moderator made the edit, without asking the moderator for phone level', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        reviewState: 'approved',
      });
      threads.findOne.mockResolvedValue(thread);

      await service.updateThread('hello-world', moderator, undefined, [
        'surgery',
      ]);

      expect(funding.sendBackToReview).toHaveBeenCalledWith(
        manager,
        thread,
        true,
      );
      expect(funding.assertCanPostAsk).not.toHaveBeenCalled();
    });

    it('treats a moderator editing their own ask as its author', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'mod-1',
        reviewState: 'approved',
      });
      threads.findOne.mockResolvedValue(thread);

      await service.updateThread('hello-world', moderator, undefined, [
        'surgery',
      ]);

      expect(funding.sendBackToReview).toHaveBeenCalledWith(
        manager,
        thread,
        false,
      );
    });

    it('keeps an approved ask live when its author resends the stored tags', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'member-1',
        reviewState: 'approved',
        tags: ['surgery', 'lisbon'],
      });
      threads.findOne.mockResolvedValue(thread);

      // Different spelling, same stored set once normalised.
      await service.updateThread('hello-world', member, undefined, [
        'Surgery',
        '#lisbon',
      ]);

      expect(funding.sendBackToReview).not.toHaveBeenCalled();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewState: 'approved',
          tags: ['surgery', 'lisbon'],
        }),
      );
    });

    it('sends an approved ask back to review when its author reorders the tags', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'member-1',
        reviewState: 'approved',
        tags: ['surgery', 'lisbon'],
      });
      threads.findOne.mockResolvedValue(thread);

      await service.updateThread('hello-world', member, undefined, [
        'lisbon',
        'surgery',
      ]);

      expect(funding.sendBackToReview).toHaveBeenCalledWith(
        manager,
        thread,
        false,
      );
    });

    it('holds a new ask title to the payment-details rule before writing', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({
          kind: 'ask',
          category: 'funding',
          authorId: 'member-1',
          reviewState: 'approved',
        }),
      );
      posts.findOne.mockResolvedValue({ ...storedOp });
      funding.assertAskTextAllowed.mockImplementation(() => {
        throw fundingException('funding_payment_details_in_body');
      });

      expect(
        await fundingCodeOf(
          service.updateThread('hello-world', member, 'MB Way 912 345 678'),
        ),
      ).toBe('funding_payment_details_in_body');
      expect(funding.assertAskTextAllowed).toHaveBeenCalledWith(
        'ask',
        'MB Way 912 345 678',
        storedOpBody,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(funding.sendBackToReview).not.toHaveBeenCalled();
    });

    it('blanks the funding details in the edit echo when a moderator hid the opening post', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'call', category: 'funding', authorId: 'member-1' }),
      );
      posts.findOne.mockResolvedValue({ ...storedOp, id: 'op-1' });
      funding.rowsByThread.mockResolvedValue(
        new Map([['thread-1', makeFundingRow()]]),
      );
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['op-1', { hidden: true, removed: false }]]),
      );

      const response = await service.updateThread(
        'hello-world',
        member,
        undefined,
        ['grants'],
      );

      expect(contentModeration.statesForAnyType).toHaveBeenCalledWith(
        ['post', 'reply'],
        ['op-1'],
      );
      expect(response.funding).toBeNull();
      expect(response.excerpt).toBeNull();
    });

    it('keeps the funding details in the edit echo when the opening post is untouched by moderation', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'call', category: 'funding', authorId: 'member-1' }),
      );
      posts.findOne.mockResolvedValue({ ...storedOp, id: 'op-1' });
      funding.rowsByThread.mockResolvedValue(
        new Map([['thread-1', makeFundingRow()]]),
      );

      const response = await service.updateThread(
        'hello-world',
        member,
        undefined,
        ['grants'],
      );

      expect(response.funding?.callState).toBe('closing');
    });

    it('drops a sent open-call tag before the five-tag cap on an ordinary thread', async () => {
      profiles.find.mockResolvedValue([baseProfile()]);

      await service.create('author-1', {
        title: 'Where do people find arts grants?',
        body: 'Any tips for a first application?',
        category: 'funding',
        kind: 'question',
        tags: ['open-call', 'grants', 'arts', 'lisbon', 'film', 'music'],
      });

      const threadsRepositoryInTransaction = manager.getRepository(
        ForumThread,
      ) as { save: jest.Mock };
      expect(threadsRepositoryInTransaction.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['grants', 'arts', 'lisbon', 'film', 'music'],
        }),
      );
    });

    it('drops a sent open-call tag before the cap on a tag edit too', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ category: 'funding', authorId: 'member-1' }),
      );

      await service.updateThread('hello-world', member, undefined, [
        '#Open-Call',
        'grants',
        'arts',
        'lisbon',
        'film',
        'music',
      ]);

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['grants', 'arts', 'lisbon', 'film', 'music'],
        }),
      );
    });

    it('still puts open-call first on a call when the member sent it too', async () => {
      threads.findOne.mockResolvedValue(
        baseThread({ kind: 'call', category: 'funding', authorId: 'member-1' }),
      );

      await service.updateThread('hello-world', member, undefined, [
        'grants',
        'open-call',
        'arts',
        'lisbon',
        'film',
        'music',
      ]);

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['open-call', 'grants', 'arts', 'lisbon', 'film'],
        }),
      );
    });

    it('ends the fundraiser for its author through the funding service', async () => {
      const thread = baseThread({
        kind: 'ask',
        category: 'funding',
        authorId: 'member-1',
        reviewState: 'approved',
      });
      threads.findOne.mockResolvedValue(thread);
      const endedRow = makeFundingRow({
        ...askRowOverrides,
        endedAt: new Date('2026-10-05T09:00:00.000Z'),
        endedReason: 'goal_reached',
      });
      funding.endAsk.mockResolvedValue(endedRow);
      funding.rowsByThread.mockResolvedValue(new Map([['thread-1', endedRow]]));
      // A fundraiser with no opening post maps no funding at all, so the
      // echo needs its OP like every real one has.
      posts.findOne.mockResolvedValue({ ...storedOp });

      const response = await service.endFundingAsk(
        'hello-world',
        member,
        'goal_reached',
      );

      expect(funding.endAsk).toHaveBeenCalledWith(
        thread,
        'member-1',
        'goal_reached',
        expect.any(Date),
      );
      expect(response.funding).toEqual(
        expect.objectContaining({
          askState: 'ended',
          endedReason: 'goal_reached',
        }),
      );
    });

    it('passes an opening-post edit to the funding rules', async () => {
      await service.applyOpBodyEditRules(
        manager as never,
        'thread-1',
        'Updated: the clinic confirmed the date.',
        false,
      );

      expect(funding.onOpBodyEdit).toHaveBeenCalledWith(
        manager,
        'thread-1',
        'Updated: the clinic confirmed the date.',
        false,
      );
    });

    it('puts fundraiser facts on review-queue rows and null on the rest, an erased author included', async () => {
      const facts = {
        linkHost: 'gofundme.com',
        posterVerificationLevel: 'phone',
        posterAccountAgeDays: 40,
      };
      const rows = [
        baseThread({ kind: 'ask', reviewState: 'pending' }),
        baseThread({ id: 'thread-2', slug: 'second', reviewState: 'pending' }),
        baseThread({
          id: 'thread-3',
          slug: 'third',
          kind: 'ask',
          authorId: null,
          reviewState: 'pending',
        }),
      ];
      threads.createQueryBuilder.mockReturnValue(qbStub(rows));
      // The funding service leaves the erased author's ask out of the map.
      funding.reviewFactsFor.mockResolvedValue(new Map([['thread-1', facts]]));

      const page = await service.listPendingReview(moderator, undefined, 20);

      expect(funding.reviewFactsFor).toHaveBeenCalledTimes(1);
      expect(page.data.map((row) => [row.id, row.fundingReview])).toEqual([
        ['thread-1', facts],
        ['thread-2', null],
        ['thread-3', null],
      ]);
    });

    it('lists running asks with the deriveAskState boundaries, an undated approval included, and never a withdrawn one', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'mod-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // A moderator's builder keeps withdrawn threads, so the asks branch
        // has to drop them itself.
        true,
        { view: 'asks' },
      );

      expect(andWhereSql(qb)).toContain('"t"."deleted_at" IS NULL');
      expect(andWhereSql(qb)).toContain(
        '("funding"."ends_at" >= :fundingNow OR ("funding"."ends_at" IS NULL AND ("funding"."approved_at" IS NULL OR "funding"."approved_at" >= :askAutoEndAfter)))',
      );
      const parameters = andWhereParameters(qb);
      const fundingNow = parameters.fundingNow as Date;
      const askAutoEndAfter = parameters.askAutoEndAfter as Date;
      expect(fundingNow.getTime() - askAutoEndAfter.getTime()).toBe(
        ASK_AUTO_END_MS,
      );
    });

    it('keeps a rolling call open up to and including the 183rd day', async () => {
      const qb = qbStub([]);
      threads.createQueryBuilder.mockReturnValue(qb);

      await service.list(
        'viewer-1',
        'funding',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        { view: 'open' },
      );

      expect(andWhereSql(qb)).toContain(
        '(("funding"."deadline" IS NULL AND "funding"."updated_at" >= :rollingFreshAfter) OR "funding"."deadline" >= :fundingNow)',
      );
    });
  });
});
