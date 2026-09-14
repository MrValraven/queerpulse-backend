import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { StorageService } from '../storage/storage.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import { Activity } from './entities/activity.entity';
import {
  BoardKind,
  BoardPost,
  BoardPostStatus,
} from './entities/board-post.entity';
import {
  BoardPostResponse,
  BoardResponseKind,
} from './entities/board-post-response.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { ProfileFeaturedCommunity } from './entities/profile-featured-community.entity';
import { ProfileNowHistory } from './entities/profile-now-history.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ActivityVisibilityService } from './activity-visibility.service';
import { LastActiveService } from './last-active.service';
import { NowInsightsService } from './now-insights.service';
import { ProfilesService } from './profiles.service';
import {
  BOARD_RESPONDERS_SHOWN,
  buildBoardResponderSummary,
} from './profile-response';
import {
  BOARD_INSIGHTS_WINDOW_DAYS,
  BOARD_MATCHES_PER_POST,
} from './board-insights';

const DAY_MS = 24 * 60 * 60 * 1000;

// Responding to another member's board post (Task 3 of the
// profile-board-section plan): an offer to help, or a board-scoped hello.
// Reuses the full provider harness from `board-lifecycle.spec.ts` (every
// repository `ProfilesService` needs) plus a mock for the new
// `BoardPostResponse` repository.
describe('ProfilesService board responses', () => {
  let service: ProfilesService;
  let profiles: { findOne: jest.Mock };
  let boardPosts: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let boardResponses: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
    find: jest.Mock;
  };
  let blockFilter: { isBlockedEitherWay: jest.Mock; excludeBlocked: jest.Mock };
  let hiddenFrom: { isHiddenFrom: jest.Mock; excludeHiddenFrom: jest.Mock };
  let contentModeration: { statesForAnyType: jest.Mock };

  // Chainable stages of the reciprocal-match query
  // (`ProfilesService.getBoardInsights`). Every real TypeORM chain method
  // `mockReturnThis()`s, so a call chain resolves to the SAME mock object and
  // every stage's arguments stay inspectable afterward.
  //
  // `outerQb` is what `dataSource.createQueryBuilder()` returns. Its
  // `.from(factory, 'ranked')` mock actually INVOKES `factory` with a fresh
  // `rankedQb`, so the query built inside that callback — the `own`/`other`/
  // `profile` join, and the `applyMemberVisibilityGates` call on it — is real
  // production code running against an inspectable mock, not skipped the way
  // an un-invoked callback argument would be. `rankedQb.innerJoin`'s FIRST
  // call is the 'other' subquery factory; that one is invoked too, against
  // `otherSubQb`, for the same reason.
  //
  // None of this proves the SQL runs correctly against Postgres. A mocked
  // query builder cannot prove the `&&` overlap operator, the window-function
  // cap, or the block/hidden-from/active-status predicates actually filter
  // anything once they reach the database — it only proves the SERVICE asks
  // the query builder for the right thing (the same "wiring, not filtering"
  // scope `profiles.service.spec.ts` already tests `excludeBlocked`/
  // `excludeHiddenFrom` calls with). See the Task 5 fix report for the
  // manual, live-database verification query.
  type ChainableQb = Record<string, jest.Mock> & { getRawMany: jest.Mock };
  const chainableQb = (): ChainableQb => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'select',
      'from',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
    ]) {
      qb[method] = jest.fn().mockReturnThis();
    }
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb as ChainableQb;
  };
  let outerQb: ChainableQb;
  let rankedQb: ChainableQb;
  let otherSubQb: ChainableQb;

  let manager: {
    find: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let savedRows: BoardPost[];
  let dataSource: { transaction: jest.Mock; createQueryBuilder: jest.Mock };

  const OWNER_ID = 'owner-1';
  const VIEWER_ID = 'viewer-1';
  const NOW = new Date('2026-08-18T12:00:00.000Z').getTime();

  const findEmpty = () => ({ find: jest.fn().mockResolvedValue([]) });

  beforeEach(async () => {
    savedRows = [];
    manager = {
      find: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(
        (_entity: unknown, data: Partial<BoardPost>) =>
          ({
            ...data,
            createdAt: data.createdAt ?? new Date(NOW),
          }) as BoardPost,
      ),
      save: jest.fn((rows: BoardPost[]) => {
        savedRows = rows;
        return Promise.resolve(rows);
      }),
    };
    boardPosts = {
      find: jest.fn().mockImplementation(() => Promise.resolve(savedRows)),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    boardResponses = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      find: jest.fn(),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue({
        userId: OWNER_ID,
        slug: 'ines',
        visibility: 'open',
      }),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      excludeBlocked: jest.fn((qb: unknown) => qb),
    };
    hiddenFrom = {
      isHiddenFrom: jest.fn().mockResolvedValue(false),
      excludeHiddenFrom: jest.fn((qb: unknown) => qb),
    };
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    };

    outerQb = chainableQb();
    outerQb.from = jest.fn((factory: (qb: ChainableQb) => ChainableQb) => {
      rankedQb = chainableQb();
      // `rankedQb.innerJoin` is called three times in production:
      // (1) the 'other' subquery factory, (2) the plain `Profile` entity
      // join, (3) the `'profile.user'` relation join. Only the first call
      // takes a callback that needs invoking against a mock of its own.
      rankedQb.innerJoin = jest
        .fn()
        .mockImplementationOnce(
          (subFactory: (qb: ChainableQb) => ChainableQb) => {
            otherSubQb = chainableQb();
            subFactory(otherSubQb);
            return rankedQb;
          },
        )
        .mockImplementation(() => rankedQb);
      factory(rankedQb);
      return outerQb;
    });

    jest.useFakeTimers({ now: NOW });

    dataSource = {
      transaction: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(outerQb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        { provide: getRepositoryToken(WorkItem), useValue: findEmpty() },
        { provide: getRepositoryToken(Skill), useValue: findEmpty() },
        { provide: getRepositoryToken(BoardPost), useValue: boardPosts },
        {
          provide: getRepositoryToken(BoardPostResponse),
          useValue: boardResponses,
        },
        { provide: getRepositoryToken(Shaping), useValue: findEmpty() },
        { provide: getRepositoryToken(Activity), useValue: findEmpty() },
        { provide: getRepositoryToken(Group), useValue: findEmpty() },
        { provide: getRepositoryToken(GroupMembership), useValue: findEmpty() },
        {
          provide: getRepositoryToken(ProfileFeaturedCommunity),
          useValue: findEmpty(),
        },
        { provide: getRepositoryToken(Community), useValue: findEmpty() },
        { provide: getRepositoryToken(CommunityMember), useValue: findEmpty() },
        {
          provide: getRepositoryToken(ProfileNowHistory),
          useValue: findEmpty(),
        },
        { provide: DataSource, useValue: dataSource },
        {
          provide: VouchService,
          useValue: {
            getVouchCount: jest.fn().mockResolvedValue(0),
            getVouchCounts: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: ConnectionsService,
          useValue: { areConnected: jest.fn().mockResolvedValue(false) },
        },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: HiddenFromService, useValue: hiddenFrom },
        {
          provide: HandlesService,
          useValue: {
            rename: jest.fn(),
            previousProfileOwnerOf: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        { provide: ContentModerationService, useValue: contentModeration },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: ActivityVisibilityService,
          useValue: {
            filterVisible: jest
              .fn()
              .mockImplementation((rows: unknown[]) => Promise.resolve(rows)),
          },
        },
        {
          provide: LastActiveService,
          useValue: {
            getSignal: jest
              .fn()
              .mockResolvedValue({ band: null, isHidden: false }),
            getSignals: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          // Its own spec covers the aggregate; every assertion in this file
          // is indifferent to `respondsWithin`, so a plain null default keeps
          // them all unaffected by its addition.
          provide: NowInsightsService,
          useValue: { getRespondsWithin: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    service = module.get(ProfilesService);

    dataSource.transaction.mockImplementation(
      async (cb: (m: typeof manager) => Promise<void>) => cb(manager),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const livePost = (over: Partial<BoardPost> = {}) =>
    ({
      id: 'post-1',
      userId: OWNER_ID,
      kind: BoardKind.Looking,
      title: 'A collaborator for a queer zine',
      slug: 'zine-collab',
      status: BoardPostStatus.Open,
      expiresAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000),
      createdAt: new Date(NOW - 25 * 24 * 60 * 60 * 1000),
      tags: ['Illustration'],
      renewedAt: null,
      renewCount: 0,
      ...over,
    }) as BoardPost;

  it('records an offer to help', async () => {
    boardPosts.findOne.mockResolvedValue(livePost());
    boardResponses.findOne.mockResolvedValue(null);
    // Repository.create takes ONE argument (unlike EntityManager.create,
    // which the transactional `manager.create` above mirrors) — the
    // production code calls `this.boardResponses.create({ ... })` directly.
    boardResponses.create.mockImplementation(
      (data: Partial<BoardPostResponse>) =>
        ({ ...data, createdAt: new Date(NOW) }) as BoardPostResponse,
    );
    boardResponses.save.mockImplementation((row: BoardPostResponse) =>
      Promise.resolve(row),
    );

    const result = await service.respondToBoardItem(
      VIEWER_ID,
      'ines',
      'zine-collab',
      BoardResponseKind.Help,
      'I illustrate and would love in.',
    );

    expect(result.kind).toBe('help');
    expect(boardResponses.save).toHaveBeenCalled();
  });

  it('rejects a second identical response', async () => {
    boardPosts.findOne.mockResolvedValue(livePost());
    boardResponses.findOne.mockResolvedValue({
      id: 'existing',
    });

    await expect(
      service.respondToBoardItem(
        VIEWER_ID,
        'ines',
        'zine-collab',
        BoardResponseKind.Help,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(boardResponses.save).not.toHaveBeenCalled();
  });

  it('refuses the owner responding to their own post', async () => {
    boardPosts.findOne.mockResolvedValue(livePost());

    await expect(
      service.respondToBoardItem(
        OWNER_ID,
        'ines',
        'zine-collab',
        BoardResponseKind.Help,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a closed post', async () => {
    boardPosts.findOne.mockResolvedValue(
      livePost({ status: BoardPostStatus.Closed }),
    );

    await expect(
      service.respondToBoardItem(
        VIEWER_ID,
        'ines',
        'zine-collab',
        BoardResponseKind.Help,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an expired post', async () => {
    boardPosts.findOne.mockResolvedValue(
      livePost({ expiresAt: new Date(NOW - 1000) }),
    );

    await expect(
      service.respondToBoardItem(
        VIEWER_ID,
        'ines',
        'zine-collab',
        BoardResponseKind.Help,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a stranger when the profile is network-only', async () => {
    boardPosts.findOne.mockResolvedValue(livePost());
    // The owner profile lookup answers `network`, and areConnected is false by
    // default in the copied harness.
    profiles.findOne.mockResolvedValue({
      userId: OWNER_ID,
      slug: 'ines',
      visibility: 'network',
    });

    await expect(
      service.respondToBoardItem(
        VIEWER_ID,
        'ines',
        'zine-collab',
        BoardResponseKind.Help,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('board responders on the profile read', () => {
    it('caps the avatar list and reports the full count separately', () => {
      const responders = [
        { slug: 'beatriz', first: 'Beatriz' },
        { slug: 'tomas', first: 'Tomás' },
        { slug: 'duarte', first: 'Duarte' },
        { slug: 'vera', first: 'Vera' },
      ];
      const view = buildBoardResponderSummary(responders, 4);

      expect(view.responders).toHaveLength(BOARD_RESPONDERS_SHOWN);
      expect(view.responseCount).toBe(4);
    });

    it('hides an avatar url when the responder hides their photo', () => {
      const view = buildBoardResponderSummary(
        [
          {
            slug: 'beatriz',
            first: 'Beatriz',
            avatarUrl: 'https://example.test/b.jpg',
            photoVisible: false,
          },
        ],
        1,
      );

      expect(view.responders[0]!.avatarUrl).toBeNull();
      expect(view.responders[0]!.initials).toBe('B');
    });

    it('renders two-letter initials from first and last name', () => {
      const view = buildBoardResponderSummary(
        [{ slug: 'beatriz', first: 'Beatriz', last: 'Ferreira' }],
        1,
      );

      expect(view.responders[0]!.last).toBe('Ferreira');
      expect(view.responders[0]!.initials).toBe('BF');
    });

    it('falls back to a single letter when the responder has no last name', () => {
      const view = buildBoardResponderSummary(
        [{ slug: 'beatriz', first: 'Beatriz', last: null }],
        1,
      );

      expect(view.responders[0]!.last).toBeNull();
      expect(view.responders[0]!.initials).toBe('B');
    });
  });

  describe('getBoardInsights', () => {
    const matchRow = (over: Record<string, unknown> = {}) => ({
      owner_post_slug: 'zine-collab',
      slug: 'beatriz',
      first: 'Beatriz',
      kind: 'offering',
      post_slug: 'riso-help',
      matched_user_id: 'beatriz-user-id',
      ...over,
    });

    it('counts hellos and replies over the window and keys matches by post slug', async () => {
      boardPosts.find.mockResolvedValue([
        livePost({ id: 'post-1', slug: 'zine-collab', tags: ['Illustration'] }),
      ]);
      boardResponses.count
        .mockResolvedValueOnce(5) // hellos
        .mockResolvedValueOnce(5); // replies
      outerQb.getRawMany.mockResolvedValue([matchRow()]);

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.hellos).toBe(5);
      expect(insights.replies).toBe(5);
      expect(insights.windowDays).toBe(90);
      expect(insights.matches['zine-collab']).toEqual([
        {
          slug: 'beatriz',
          first: 'Beatriz',
          kind: 'offering',
          postSlug: 'riso-help',
        },
      ]);
    });

    it('returns empty matches when the owner has no tagged posts, without ever building the match query', async () => {
      boardPosts.find.mockResolvedValue([livePost({ tags: [] })]);
      boardResponses.count.mockResolvedValue(0);

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.matches).toEqual({});
      // The empty-tags guard must short-circuit BEFORE the query is even
      // built — `getRawMany` defaulting to `[]` would make this test pass
      // whether or not the guard exists, so the only real proof is that the
      // query builder was never asked for in the first place.
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('excludes a closed post from the match query', async () => {
      // Deleting `post.status === BoardPostStatus.Open` from the `matchable`
      // filter would fail nothing without this: `livePost()` defaults to
      // open, and the only other negative case above uses an empty-tags
      // post, never a closed one.
      boardPosts.find.mockResolvedValue([
        livePost({ status: BoardPostStatus.Closed, tags: ['Illustration'] }),
      ]);
      boardResponses.count.mockResolvedValue(0);

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.matches).toEqual({});
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('excludes an expired post from the match query', async () => {
      // Same reasoning as the closed-post case above, for
      // `post.expiresAt > now` instead of `post.status`.
      boardPosts.find.mockResolvedValue([
        livePost({
          expiresAt: new Date(NOW - 1000),
          tags: ['Illustration'],
        }),
      ]);
      boardResponses.count.mockResolvedValue(0);

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.matches).toEqual({});
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('scopes the hellos/replies funnel to every owner post while the match query sees only the matchable subset', async () => {
      // With a single-post fixture, `ownIds` and the matchable ids are the
      // SAME array, so a swap of one for the other in either query would
      // still pass every other test in this file. Two posts, only one of
      // them matchable, is what actually distinguishes them.
      boardPosts.find.mockResolvedValue([
        livePost({ id: 'post-1', slug: 'zine-collab', tags: ['Illustration'] }),
        livePost({ id: 'post-2', slug: 'untagged-ask', tags: [] }),
      ]);
      boardResponses.count.mockResolvedValue(0);
      outerQb.getRawMany.mockResolvedValue([]);

      await service.getBoardInsights(OWNER_ID);

      const countCalls = boardResponses.count.mock.calls as [
        { where: { postId: { value: string[] } } },
      ][];
      expect(countCalls).toHaveLength(2);
      for (const [args] of countCalls) {
        expect(args.where.postId.value).toEqual(['post-1', 'post-2']);
      }
      expect(rankedQb.where).toHaveBeenCalledWith('own.id IN (:...ids)', {
        ids: ['post-1'],
      });
    });

    it('scopes hellos and replies to the owner posts and the trailing 90-day window', async () => {
      boardPosts.find.mockResolvedValue([
        livePost({ id: 'post-1', slug: 'zine-collab', tags: ['Illustration'] }),
      ]);
      // Deliberately DIFFERENT numbers — with 5/5 a swapped Hello/Help kind
      // filter, or a swapped return-tuple order, would still pass.
      boardResponses.count
        .mockResolvedValueOnce(5) // hellos
        .mockResolvedValueOnce(2); // replies

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.hellos).toBe(5);
      expect(insights.replies).toBe(2);
      expect(boardResponses.count).toHaveBeenCalledTimes(2);

      type CountArgs = {
        where: {
          postId: { value: string[] };
          kind: string;
          createdAt: { value: Date; type: string };
        };
      };
      const calls = boardResponses.count.mock.calls as [CountArgs][];
      const helloArgs = calls[0]![0];
      const replyArgs = calls[1]![0];

      expect(helloArgs.where.postId.value).toEqual(['post-1']);
      expect(helloArgs.where.kind).toBe(BoardResponseKind.Hello);
      expect(replyArgs.where.postId.value).toEqual(['post-1']);
      expect(replyArgs.where.kind).toBe(BoardResponseKind.Help);

      const windowStart = new Date(NOW - BOARD_INSIGHTS_WINDOW_DAYS * DAY_MS);
      for (const args of [helloArgs, replyArgs]) {
        // `MoreThanOrEqual`, not `MoreThan` — a response landing exactly on
        // the boundary still counts.
        expect(args.where.createdAt.type).toBe('moreThanOrEqual');
        expect(args.where.createdAt.value).toEqual(windowStart);
      }
    });

    it('caps matches at BOARD_MATCHES_PER_POST per owner post', async () => {
      boardPosts.find.mockResolvedValue([
        livePost({ id: 'post-1', slug: 'zine-collab', tags: ['Illustration'] }),
      ]);
      boardResponses.count.mockResolvedValue(0);
      // The SQL cap over-fetches (`BOARD_MATCHES_PER_POST * 3`) on purpose —
      // see the "wires the match query" test — so this row-loop trim is the
      // REAL enforcement of the displayed 3-per-post limit, exercised here
      // with 5 raw rows for one post standing in for what an over-fetched
      // SQL result would look like.
      outerQb.getRawMany.mockResolvedValue(
        ['a', 'b', 'c', 'd', 'e'].map((letter) =>
          matchRow({
            slug: `member-${letter}`,
            first: letter.toUpperCase(),
            post_slug: `post-${letter}`,
            matched_user_id: `user-${letter}`,
          }),
        ),
      );

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.matches['zine-collab']).toHaveLength(
        BOARD_MATCHES_PER_POST,
      );
    });

    it('drops a matched member a moderator has taken down', async () => {
      boardPosts.find.mockResolvedValue([
        livePost({ id: 'post-1', slug: 'zine-collab', tags: ['Illustration'] }),
      ]);
      boardResponses.count.mockResolvedValue(0);
      outerQb.getRawMany.mockResolvedValue([matchRow()]);
      // Unlike block/hidden-from/active-status (SQL-only, see the wiring test
      // below), moderator takedown is real application code
      // (`dropTakenDown`) that this mock genuinely exercises.
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['beatriz-user-id', { hidden: true, removed: false }]]),
      );

      const insights = await service.getBoardInsights(OWNER_ID);

      expect(insights.matches['zine-collab']).toBeUndefined();
    });

    it('wires the match query: select lists, join conditions, the cap, and the visibility gates', async () => {
      boardPosts.find.mockResolvedValue([
        livePost({ id: 'post-1', slug: 'zine-collab', tags: ['Illustration'] }),
      ]);
      boardResponses.count.mockResolvedValue(0);
      outerQb.getRawMany.mockResolvedValue([matchRow()]);

      await service.getBoardInsights(OWNER_ID);

      // The outer ("ranked") wrapper: selects the final columns off the
      // ranked derived table. The SQL cap over-fetches to
      // `BOARD_MATCHES_PER_POST * 3` (not exactly 3) so the post-query
      // moderator-takedown filter below can drop a row without leaving a
      // bucket short — the real per-post trim to 3 happens in the row loop,
      // after takedowns are removed (see the "caps matches" test below).
      expect(outerQb.select).toHaveBeenCalledWith([
        'ranked.owner_post_slug AS owner_post_slug',
        'ranked.post_slug AS post_slug',
        'ranked.kind AS kind',
        'ranked.slug AS slug',
        'ranked.first AS first',
        'ranked.matched_user_id AS matched_user_id',
      ]);
      expect(outerQb.from).toHaveBeenCalledWith(expect.any(Function), 'ranked');
      expect(outerQb.where).toHaveBeenCalledWith('ranked.rn <= :cap', {
        cap: BOARD_MATCHES_PER_POST * 3,
      });
      expect(outerQb.orderBy).toHaveBeenCalledWith('ranked.rn', 'ASC');

      // The `own`/`other`/`profile` join and its window function.
      expect(rankedQb.select).toHaveBeenCalledWith([
        'own.slug AS owner_post_slug',
        'other.post_slug AS post_slug',
        'other.kind AS kind',
        'profile.slug AS slug',
        'profile.first_name AS first',
        'other.user_id AS matched_user_id',
        'ROW_NUMBER() OVER (PARTITION BY own.id ORDER BY other.created_at DESC, other.post_slug ASC) AS rn',
      ]);
      expect(rankedQb.from).toHaveBeenCalledWith(BoardPost, 'own');
      expect(rankedQb.innerJoin).toHaveBeenNthCalledWith(
        1,
        expect.any(Function),
        'other',
        'other.tags && own.tags AND other.kind != own.kind',
      );
      expect(rankedQb.innerJoin).toHaveBeenNthCalledWith(
        2,
        Profile,
        'profile',
        'profile.user_id = other.user_id',
      );
      expect(rankedQb.innerJoin).toHaveBeenNthCalledWith(
        3,
        'profile.user',
        'profileUser',
        'profileUser.status = :active',
        { active: UserStatus.Active },
      );
      expect(rankedQb.where).toHaveBeenCalledWith('own.id IN (:...ids)', {
        ids: ['post-1'],
      });

      // The 'other' post subquery: open, unexpired, and not the owner's own.
      expect(otherSubQb.select).toHaveBeenCalledWith([
        'other.slug AS post_slug',
        'other.kind AS kind',
        'other.user_id AS user_id',
        'other.tags AS tags',
        'other.created_at AS created_at',
      ]);
      expect(otherSubQb.from).toHaveBeenCalledWith(BoardPost, 'other');
      expect(otherSubQb.where).toHaveBeenCalledWith('other.status = :open', {
        open: BoardPostStatus.Open,
      });
      expect(otherSubQb.andWhere).toHaveBeenNthCalledWith(
        1,
        'other.expires_at > now()',
      );
      expect(otherSubQb.andWhere).toHaveBeenNthCalledWith(
        2,
        'other.user_id != :userId',
        { userId: OWNER_ID },
      );

      // The visibility gates — `applyMemberVisibilityGates(inner, userId,
      // 'profile')` — called on `rankedQb` with the OWNER as the viewer and
      // the `'profile'` alias (not the directory's `'p'`), which is what lets
      // this reuse the SAME helper `directoryBaseQuery` uses rather than
      // re-spelling the four gates a second time. Block/hidden-from/
      // active-status filtering itself is SQL the mock cannot execute — this
      // proves the call is wired correctly, not that Postgres enforces it;
      // see the Task 5 fix report's manual verification query.
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        rankedQb,
        OWNER_ID,
        '"profile"."user_id"',
      );
      expect(hiddenFrom.excludeHiddenFrom).toHaveBeenCalledWith(
        rankedQb,
        OWNER_ID,
        '"profile"."user_id"',
      );
      expect(rankedQb.andWhere).toHaveBeenCalledWith(
        '("profile"."hidden_until" IS NULL OR "profile"."hidden_until" <= now())',
      );
    });
  });
});
