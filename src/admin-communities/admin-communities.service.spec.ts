import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindManyOptions, FindOperator, In } from 'typeorm';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminCommunitiesService } from './admin-communities.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-07-19T12:00:00.000Z');

// `post.id`/`reply.id` are `@PrimaryGeneratedColumn('uuid')` columns, so any
// report `subjectId` fixture that is meant to actually resolve through
// `loadPostCommunityIds`/`loadReplyCommunityIds` must be UUID-shaped —
// mirroring what `UUID_RE` in the service requires of a real one. Using
// non-UUID strings like `'post-1'` here would demonstrate the exact hazard
// the CRITICAL fix closes: a mocked query builder swallows any string, but
// real Postgres would reject it with "invalid input syntax for type uuid".
const REPORTED_POST_ID = '11111111-1111-1111-1111-111111111111';
const REPORTED_REPLY_ID = '22222222-2222-2222-2222-222222222222';
const REPORTED_POST_ID_ANOTHER_COMMUNITY =
  '33333333-3333-3333-3333-333333333333';

function daysAgo(days: number): Date {
  return new Date(FIXED_NOW.getTime() - days * DAY_MS);
}

function makeCommunity(overrides: Partial<Community> = {}): Community {
  return {
    id: 'community-1',
    slug: 'circle-of-care',
    name: 'Circle of Care',
    purpose: 'A place to land softly.',
    type: CommunityType.Support,
    whoFor: 'Anyone who needs it.',
    tagline: 'Softly, together.',
    accessTier: AccessTier.Request,
    rosterVisible: true,
    features: [],
    rules: [],
    ownerId: 'user-owner',
    ref: 'CMT-0001',
    createdAt: daysAgo(400),
    updatedAt: daysAgo(400),
    ...overrides,
  };
}

function makeCommunityMember(
  overrides: Partial<CommunityMember> = {},
): CommunityMember {
  return {
    id: 'member-1',
    communityId: 'community-1',
    userId: 'user-owner',
    role: RosterRole.Member,
    joinedAt: daysAgo(300),
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    subjectType: ReportSubjectType.Post,
    subjectId: REPORTED_POST_ID,
    reasonCode: 'harassment',
    detail: 'Repeated targeting in the thread.',
    anonymous: false,
    contactEmail: null,
    evidence: null,
    severity: ReportSeverity.High,
    slaDueAt: daysAgo(1),
    status: ReportStatus.Open,
    reporterId: 'user-reporter',
    createdAt: daysAgo(2),
    ...overrides,
  };
}

/** Only the fields `toMemberRef` reads — the rest of `Profile` is irrelevant
 *  to this service and left off deliberately. */
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-owner',
    slug: 'ada-lovelace',
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: null,
    ...overrides,
  } as unknown as Profile;
}

type QueryBuilderStub = Record<string, jest.Mock>;

const CHAINED_BUILDER_METHODS = [
  'select',
  'addSelect',
  'innerJoin',
  'where',
  'andWhere',
  'groupBy',
  'orderBy',
];

/** Stubs the fluent `createQueryBuilder` chain: every builder method returns
 *  the builder itself, and `getRawMany` resolves the given raw rows. */
function makeQueryBuilderStub(rawRows: unknown[]): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {};
  for (const chainedMethod of CHAINED_BUILDER_METHODS) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rawRows);
  return queryBuilder;
}

/** Stubs the `reports` repository's `createQueryBuilder` chain: unlike the
 *  raw-row builders above, `loadReportScope` projects a fixed column list off
 *  an entity query builder and calls `getMany`, not `getRawMany`. Returns the
 *  builder stub so callers can assert on `.select`/`.where`/`.orderBy`. */
function stubReportsQueryBuilder(
  createQueryBuilder: jest.Mock,
  reportRows: Report[],
): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {};
  for (const chainedMethod of ['select', 'where', 'orderBy']) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(reportRows);
  createQueryBuilder.mockReturnValue(queryBuilder);
  return queryBuilder;
}

/**
 * Hands out one builder stub per query against a repository, keyed by the
 * first argument the service passes to `.select()` — `'post.id'` for the
 * reported-content-id map, `'post.community_id'` for the 56-day activity
 * window, and so on.
 *
 * Keying off the projection rather than off call order keeps this spec
 * independent of how the service groups its queries into `Promise.all`s: a
 * regrouping changes which query lands first, but never what it selects.
 *
 * Some queries (`innerJoin`) call builder methods before `.select()`, so calls
 * seen before the key is known are buffered and replayed onto the chosen stub
 * — assertions on `innerJoin` still land on the right builder.
 */
function queueQueryBuilders(
  createQueryBuilder: jest.Mock,
  rawRowsBySelectedColumn: Record<string, unknown[]>,
): Record<string, QueryBuilderStub> {
  const queryBuildersBySelectedColumn: Record<string, QueryBuilderStub> = {};
  for (const [selectedColumn, rawRows] of Object.entries(
    rawRowsBySelectedColumn,
  )) {
    queryBuildersBySelectedColumn[selectedColumn] =
      makeQueryBuilderStub(rawRows);
  }

  createQueryBuilder.mockImplementation(() => {
    const callsBeforeSelect: Array<{
      method: string;
      args: unknown[];
    }> = [];
    const dispatcher: QueryBuilderStub = {};
    for (const chainedMethod of CHAINED_BUILDER_METHODS) {
      dispatcher[chainedMethod] = jest.fn((...args: unknown[]) => {
        if (chainedMethod !== 'select') {
          callsBeforeSelect.push({ method: chainedMethod, args });
          return dispatcher;
        }
        const selectedColumn = String(args[0]);
        const queryBuilder = queryBuildersBySelectedColumn[selectedColumn];
        if (!queryBuilder) {
          throw new Error(
            `This test queued no query-builder stub for select('${selectedColumn}'); queued keys: ${Object.keys(
              queryBuildersBySelectedColumn,
            ).join(', ')}`,
          );
        }
        for (const bufferedCall of callsBeforeSelect) {
          queryBuilder[bufferedCall.method](...bufferedCall.args);
        }
        queryBuilder.select(...args);
        return queryBuilder;
      });
    }
    return dispatcher;
  });

  return queryBuildersBySelectedColumn;
}

describe('AdminCommunitiesService', () => {
  let service: AdminCommunitiesService;
  let communities: { find: jest.Mock; findOne: jest.Mock };
  let communityMembers: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let communityPosts: { createQueryBuilder: jest.Mock };
  let communityPostReplies: { createQueryBuilder: jest.Mock };
  let reports: { createQueryBuilder: jest.Mock };
  let profiles: { find: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    communities = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
    communityMembers = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub([])),
    };
    communityPosts = {
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub([])),
    };
    communityPostReplies = {
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub([])),
    };
    reports = { createQueryBuilder: jest.fn() };
    stubReportsQueryBuilder(reports.createQueryBuilder, []);
    profiles = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCommunitiesService,
        { provide: getRepositoryToken(Community), useValue: communities },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        {
          provide: getRepositoryToken(CommunityPost),
          useValue: communityPosts,
        },
        {
          provide: getRepositoryToken(CommunityPostReply),
          useValue: communityPostReplies,
        },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(AdminCommunitiesService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('listCommunities', () => {
    it('returns one card per community', async () => {
      communities.find.mockResolvedValue([
        makeCommunity(),
        makeCommunity({
          id: 'community-2',
          slug: 'loud-and-proud',
          name: 'Loud And Proud',
          type: CommunityType.Activism,
        }),
      ]);
      queueQueryBuilders(communityPosts.createQueryBuilder, {
        'post.id': [],
        'post.community_id': [],
      });
      queueQueryBuilders(communityPostReplies.createQueryBuilder, {
        'reply.id': [],
        'post.community_id': [],
      });
      queueQueryBuilders(communityMembers.createQueryBuilder, {
        'member.community_id': [
          { communityId: 'community-1', count: '12' },
          { communityId: 'community-2', count: '4' },
        ],
      });

      const result = await service.listCommunities();

      expect(result).toHaveLength(2);
      expect(result.map((card) => card.slug).sort()).toEqual([
        'circle-of-care',
        'loud-and-proud',
      ]);
      const circleOfCareCard = result.find(
        (card) => card.slug === 'circle-of-care',
      );
      expect(circleOfCareCard?.memberCount).toBe(12);
      expect(circleOfCareCard?.name).toBe('Circle of Care');
      expect(circleOfCareCard?.initials).toBe('CO');
      // One grouped member-count query for the whole set, not one per community.
      expect(communityMembers.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('sorts the communities that need attention first', async () => {
      communities.find.mockResolvedValue([
        makeCommunity({
          id: 'community-busy',
          slug: 'loud-and-proud',
          name: 'Loud And Proud',
        }),
        makeCommunity({
          id: 'community-quiet',
          slug: 'quiet-corner',
          name: 'Quiet Corner',
        }),
      ]);
      queueQueryBuilders(communityPosts.createQueryBuilder, {
        'post.id': [],
        'post.community_id': [
          {
            communityId: 'community-busy',
            authorId: 'user-a',
            createdAt: daysAgo(1),
          },
          {
            communityId: 'community-busy',
            authorId: 'user-b',
            createdAt: daysAgo(2),
          },
        ],
      });
      queueQueryBuilders(communityPostReplies.createQueryBuilder, {
        'reply.id': [],
        'post.community_id': [],
      });
      queueQueryBuilders(communityMembers.createQueryBuilder, {
        'member.community_id': [{ communityId: 'community-busy', count: '2' }],
      });

      const result = await service.listCommunities();

      // Quiet Corner has nobody active at all, so it scores lower and leads.
      expect(result.map((card) => card.slug)).toEqual([
        'quiet-corner',
        'loud-and-proud',
      ]);
      expect(result[0].healthScore).toBeLessThan(result[1].healthScore);
      expect(result[1].activePercentage).toBe(100);
      expect(result[0].activePercentage).toBe(0);
      expect(result[0].activityLabel).toBe('Quiet');
    });

    it('excludes flat posts with a null community id from post counts', async () => {
      communities.find.mockResolvedValue([makeCommunity()]);
      // Reported content ids are what drive the id-map queries now, so this
      // report is what makes those two builders run at all.
      stubReportsQueryBuilder(reports.createQueryBuilder, [
        makeReport({ subjectId: REPORTED_POST_ID }),
        makeReport({
          id: 'report-reply',
          subjectType: ReportSubjectType.Reply,
          subjectId: REPORTED_REPLY_ID,
        }),
      ]);
      const postQueryBuilders = queueQueryBuilders(
        communityPosts.createQueryBuilder,
        {
          'post.id': [
            { contentId: REPORTED_POST_ID, communityId: 'community-1' },
          ],
          'post.community_id': [
            {
              communityId: 'community-1',
              authorId: 'user-a',
              createdAt: daysAgo(1),
            },
            // A flat/global post: it belongs to no community. The IS NOT NULL
            // guard keeps it out of the query, and the service drops it too
            // rather than opening a phantom NULL bucket.
            {
              communityId: null,
              authorId: 'user-b',
              createdAt: daysAgo(1),
            },
          ],
        },
      );
      const replyQueryBuilders = queueQueryBuilders(
        communityPostReplies.createQueryBuilder,
        {
          'reply.id': [
            { contentId: REPORTED_REPLY_ID, communityId: 'community-1' },
          ],
          'post.community_id': [],
        },
      );
      queueQueryBuilders(communityMembers.createQueryBuilder, {
        'member.community_id': [{ communityId: 'community-1', count: '1' }],
      });

      const result = await service.listCommunities();

      for (const queryBuilder of [
        postQueryBuilders['post.id'],
        postQueryBuilders['post.community_id'],
        replyQueryBuilders['reply.id'],
        replyQueryBuilders['post.community_id'],
      ]) {
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          'post.community_id IS NOT NULL',
        );
      }
      // Replies have no community_id of their own — they join through posts.
      expect(
        replyQueryBuilders['post.community_id'].innerJoin,
      ).toHaveBeenCalledWith(CommunityPost, 'post', 'post.id = reply.post_id');
      // Only the single non-null post is counted; no phantom NULL bucket.
      expect(
        result[0].activitySparkline.reduce((sum, week) => sum + week, 0),
      ).toBe(1);
    });

    it('returns eight sparkline buckets even for a community with no posts', async () => {
      communities.find.mockResolvedValue([makeCommunity()]);

      const result = await service.listCommunities();

      expect(result[0].activitySparkline).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(result[0].activityLabel).toBe('Quiet');
    });

    it('buckets fifty-six days of posts and replies into eight weeks, oldest first', async () => {
      communities.find.mockResolvedValue([makeCommunity()]);
      const postQueryBuilders = queueQueryBuilders(
        communityPosts.createQueryBuilder,
        {
          'post.id': [],
          'post.community_id': [
            {
              communityId: 'community-1',
              authorId: 'user-a',
              createdAt: daysAgo(50),
            },
          ],
        },
      );
      queueQueryBuilders(communityPostReplies.createQueryBuilder, {
        'reply.id': [],
        'post.community_id': [
          {
            communityId: 'community-1',
            authorId: 'user-b',
            createdAt: daysAgo(1),
          },
        ],
      });

      const result = await service.listCommunities();

      // The 50-day-old post lands in the oldest bucket, the 1-day-old reply in
      // the newest; the six weeks between are explicit zeros, not gaps.
      expect(result[0].activitySparkline).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
      expect(
        postQueryBuilders['post.community_id'].andWhere,
      ).toHaveBeenCalledWith('post.created_at >= :sparklineWindowStart', {
        sparklineWindowStart: new Date(FIXED_NOW.getTime() - 56 * DAY_MS),
      });
    });

    it('counts a post from outside the last seven days in the sparkline but not in the weekly numbers', async () => {
      communities.find.mockResolvedValue([makeCommunity()]);
      queueQueryBuilders(communityPosts.createQueryBuilder, {
        'post.id': [],
        // Eight days old: inside the 56-day fetch window, outside the 7-day
        // in-memory window the weekly numbers are derived from.
        'post.community_id': [
          {
            communityId: 'community-1',
            authorId: 'user-a',
            createdAt: daysAgo(8),
          },
        ],
      });
      queueQueryBuilders(communityPostReplies.createQueryBuilder, {
        'reply.id': [],
        'post.community_id': [],
      });
      queueQueryBuilders(communityMembers.createQueryBuilder, {
        'member.community_id': [{ communityId: 'community-1', count: '4' }],
      });

      const result = await service.listCommunities();

      // Present in the trend line, in the second-newest bucket.
      expect(result[0].activitySparkline).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
      // ...but it is not this week's activity.
      expect(result[0].activityLabel).toBe('Quiet');
      expect(result[0].activePercentage).toBe(0);
      expect(result[0].healthBreakdown.memberActivity).toBe(0);
    });

    it('counts an author who both posted and replied this week only once as active', async () => {
      communities.find.mockResolvedValue([makeCommunity()]);
      queueQueryBuilders(communityPosts.createQueryBuilder, {
        'post.id': [],
        'post.community_id': [
          {
            communityId: 'community-1',
            authorId: 'user-prolific',
            createdAt: daysAgo(2),
          },
        ],
      });
      queueQueryBuilders(communityPostReplies.createQueryBuilder, {
        'reply.id': [],
        'post.community_id': [
          {
            communityId: 'community-1',
            authorId: 'user-prolific',
            createdAt: daysAgo(1),
          },
        ],
      });
      queueQueryBuilders(communityMembers.createQueryBuilder, {
        'member.community_id': [{ communityId: 'community-1', count: '4' }],
      });

      const result = await service.listCommunities();

      // One of four members was active, not two of four: the same author
      // showing up in both the post and the reply window is one person.
      expect(result[0].activePercentage).toBe(25);
      expect(result[0].healthBreakdown.memberActivity).toBe(25);
      // Both rows still contribute to the trend line.
      expect(
        result[0].activitySparkline.reduce((sum, week) => sum + week, 0),
      ).toBe(2);
    });

    it('returns an empty array when the platform has no communities yet', async () => {
      communities.find.mockResolvedValue([]);

      await expect(service.listCommunities()).resolves.toEqual([]);
      expect(communityPosts.createQueryBuilder).not.toHaveBeenCalled();
      expect(communityPostReplies.createQueryBuilder).not.toHaveBeenCalled();
      expect(communityMembers.createQueryBuilder).not.toHaveBeenCalled();
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getCommunity', () => {
    it('404s on an unknown slug', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(service.getCommunity('no-such-place')).rejects.toThrow(
        NotFoundException,
      );
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { slug: 'no-such-place' },
      });
    });

    it('lists owners and mods as moderators and plain members not at all', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const fullRoster = [
        makeCommunityMember({
          id: 'member-owner',
          userId: 'user-owner',
          role: RosterRole.Owner,
          joinedAt: daysAgo(300),
        }),
        makeCommunityMember({
          id: 'member-mod',
          userId: 'user-mod',
          role: RosterRole.Mod,
          joinedAt: daysAgo(200),
        }),
        makeCommunityMember({
          id: 'member-plain',
          userId: 'user-plain',
          role: RosterRole.Member,
          joinedAt: daysAgo(100),
        }),
      ];
      // Honour the role filter the service asks for, so a plain member is
      // excluded by the query rather than by the fixture.
      communityMembers.find.mockImplementation(
        (options: FindManyOptions<CommunityMember>) => {
          // `In(...)` holds the whole array in `value`, though `FindOperator`
          // declares it as the element type.
          const roleFilter = (
            options.where as unknown as { role: FindOperator<RosterRole[]> }
          ).role;
          return Promise.resolve(
            fullRoster.filter((member) =>
              roleFilter.value.includes(member.role),
            ),
          );
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile(),
        makeProfile({
          userId: 'user-mod',
          slug: 'marsha-p',
          firstName: 'Marsha',
          lastName: 'Johnson',
        }),
        makeProfile({
          userId: 'user-plain',
          slug: 'plain-pat',
          firstName: 'Pat',
          lastName: 'Plain',
        }),
      ]);

      const result = await service.getCommunity('circle-of-care');

      expect(communityMembers.find).toHaveBeenCalledWith({
        where: {
          communityId: 'community-1',
          role: In([RosterRole.Owner, RosterRole.Mod]),
        },
        order: { joinedAt: 'ASC' },
      });
      expect(result.moderators).toEqual([
        {
          slug: 'ada-lovelace',
          name: 'Ada Lovelace',
          initials: 'AL',
          role: 'owner',
          joinedAt: daysAgo(300).toISOString(),
        },
        {
          slug: 'marsha-p',
          name: 'Marsha Johnson',
          initials: 'MJ',
          role: 'mod',
          joinedAt: daysAgo(200).toISOString(),
        },
      ]);
      expect(
        result.moderators.some((moderator) => moderator.slug === 'plain-pat'),
      ).toBe(false);
      expect(result.description).toBe('A place to land softly.');
      expect(result.visibility).toBe('network');
      expect(result.foundedAt).toBe(daysAgo(400).toISOString());
    });

    it("scopes the queue to that community's open reports", async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const postQueryBuilders = queueQueryBuilders(
        communityPosts.createQueryBuilder,
        {
          'post.id': [
            { contentId: REPORTED_POST_ID, communityId: 'community-1' },
          ],
          'post.community_id': [],
        },
      );
      const replyQueryBuilders = queueQueryBuilders(
        communityPostReplies.createQueryBuilder,
        {
          'reply.id': [
            { contentId: REPORTED_REPLY_ID, communityId: 'community-1' },
          ],
          'post.community_id': [],
        },
      );
      const reportsQueryBuilder = stubReportsQueryBuilder(
        reports.createQueryBuilder,
        [
          makeReport({
            id: 'report-open-post',
            subjectId: REPORTED_POST_ID,
            status: ReportStatus.Open,
            slaDueAt: daysAgo(1),
            createdAt: daysAgo(3),
          }),
          makeReport({
            id: 'report-resolved-reply',
            subjectType: ReportSubjectType.Reply,
            subjectId: REPORTED_REPLY_ID,
            status: ReportStatus.Resolved,
          }),
          makeReport({
            id: 'report-open-community',
            subjectType: ReportSubjectType.Community,
            subjectId: 'circle-of-care',
            severity: ReportSeverity.Low,
            status: ReportStatus.Open,
            slaDueAt: new Date(FIXED_NOW.getTime() + DAY_MS),
            createdAt: daysAgo(1),
            detail: null,
          }),
          // A real, UUID-shaped content id that happens to belong to a
          // different community — the mocked 'post.id' resolution above never
          // returns a row for it, so it should resolve to no community and be
          // dropped, the same as any other out-of-scope subject.
          makeReport({
            id: 'report-open-elsewhere',
            subjectId: REPORTED_POST_ID_ANOTHER_COMMUNITY,
            status: ReportStatus.Open,
          }),
        ],
      );

      const result = await service.getCommunity('circle-of-care');

      // Reports are fetched first, narrowed only by subject type — never by a
      // subject-id list built from every post and reply on the platform, which
      // is what used to overflow Postgres' bind-parameter cap. Only the
      // columns `scopedQueueFor`/`summariseReportsByCommunity` actually read
      // are projected (MINOR 1), not the full row.
      expect(reportsQueryBuilder.select).toHaveBeenCalledWith([
        'report.id',
        'report.subjectType',
        'report.subjectId',
        'report.severity',
        'report.reasonCode',
        'report.detail',
        'report.status',
        'report.slaDueAt',
        'report.createdAt',
      ]);
      expect(reportsQueryBuilder.where).toHaveBeenCalledWith(
        'report.subjectType IN (:...subjectTypes)',
        {
          subjectTypes: [
            ReportSubjectType.Post,
            ReportSubjectType.Reply,
            ReportSubjectType.Community,
          ],
        },
      );
      expect(reportsQueryBuilder.orderBy).toHaveBeenCalledWith(
        'report.createdAt',
        'DESC',
      );
      // Only the ids the reports actually reference are resolved, and the
      // `community`-subject report's slug is not among them — it resolves
      // through the slug map instead.
      const expectedReportedContentIds = [
        REPORTED_POST_ID,
        REPORTED_REPLY_ID,
        REPORTED_POST_ID_ANOTHER_COMMUNITY,
      ];
      expect(postQueryBuilders['post.id'].where).toHaveBeenCalledWith(
        'post.id IN (:...reportedContentIds)',
        { reportedContentIds: expectedReportedContentIds },
      );
      // Reported replies resolve to their PARENT POST's community.
      expect(replyQueryBuilders['reply.id'].where).toHaveBeenCalledWith(
        'reply.id IN (:...reportedContentIds)',
        { reportedContentIds: expectedReportedContentIds },
      );
      expect(replyQueryBuilders['reply.id'].innerJoin).toHaveBeenCalledWith(
        CommunityPost,
        'post',
        'post.id = reply.post_id',
      );
      // Open only, newest first; the resolved one and the other community's
      // report are both dropped.
      expect(result.scopedQueue.map((queueItem) => queueItem.id)).toEqual([
        'report-open-community',
        'report-open-post',
      ]);
      expect(result.scopedQueue[0]).toEqual({
        id: 'report-open-community',
        severity: ReportSeverity.Low,
        reasonCode: 'harassment',
        detail: null,
        status: ReportStatus.Open,
        overdue: false,
        createdAt: daysAgo(1).toISOString(),
      });
      expect(result.scopedQueue[1].overdue).toBe(true);
      // Three reports resolved to this community, one of them resolved-status.
      expect(result.openReportCount).toBe(2);
      expect(result.resolvedPercentage).toBe(33);
    });

    // Regression for the CRITICAL fix: `CreateReportDto` only validates
    // `subjectId` as a 1-200 char string, so any member can `POST /reports`
    // with `subjectId: "x"`. `post.id`/`reply.id` are `uuid` columns — an
    // unfiltered non-UUID id reaching their `IN (...)` clause would 500 real
    // Postgres with "invalid input syntax for type uuid", even though a mock
    // here would happily swallow it. A non-UUID subject id must never reach
    // either lookup's bind parameters.
    it('drops a non-UUID subjectId before it can reach the post/reply id lookups', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const postQueryBuilders = queueQueryBuilders(
        communityPosts.createQueryBuilder,
        {
          'post.id': [
            { contentId: REPORTED_POST_ID, communityId: 'community-1' },
          ],
          'post.community_id': [],
        },
      );
      const replyQueryBuilders = queueQueryBuilders(
        communityPostReplies.createQueryBuilder,
        {
          'reply.id': [],
          'post.community_id': [],
        },
      );
      stubReportsQueryBuilder(reports.createQueryBuilder, [
        // Junk, non-UUID subjectId — exactly what an unvalidated
        // `POST /reports` body can produce.
        makeReport({
          id: 'report-junk-subject-id',
          subjectId: 'x',
          status: ReportStatus.Open,
        }),
        makeReport({
          id: 'report-real-post',
          subjectId: REPORTED_POST_ID,
          status: ReportStatus.Open,
        }),
      ]);

      const result = await service.getCommunity('circle-of-care');

      // Only the real, UUID-shaped id is bound into either lookup — 'x' never
      // reaches a uuid column comparison.
      expect(postQueryBuilders['post.id'].where).toHaveBeenCalledWith(
        'post.id IN (:...reportedContentIds)',
        { reportedContentIds: [REPORTED_POST_ID] },
      );
      expect(replyQueryBuilders['reply.id'].where).toHaveBeenCalledWith(
        'reply.id IN (:...reportedContentIds)',
        { reportedContentIds: [REPORTED_POST_ID] },
      );
      // The junk-subject report resolves to no community (its id was never
      // looked up) and is excluded from the queue; the real one is kept.
      expect(result.scopedQueue.map((queueItem) => queueItem.id)).toEqual([
        'report-real-post',
      ]);
    });
  });
});
