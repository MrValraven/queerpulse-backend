import { Repository } from 'typeorm';
import { PAGE_SIZE } from '../common/pagination';
import { ConnectionStatus } from '../connections/entities/connection.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import {
  buildInviteCandidatesQuery,
  listInviteCandidates,
} from './community-invite-candidates';
import { whereInviteIsLive } from './community-invite-liveness';
import { CommunityInvite } from './entities/community-invite.entity';
import { JoinRequestStatus } from './entities/community-join-request.entity';

// The liveness predicate's own clauses are covered by
// `community-invite-liveness.spec.ts`; here it only has to be the one that
// shapes the "already invited" subquery.
jest.mock('./community-invite-liveness');
const mockedWhereInviteIsLive = jest.mocked(whereInviteIsLive);

const RECORDED_METHODS = [
  'select',
  'setParameter',
  'setParameters',
  'innerJoin',
  'where',
  'andWhere',
  'orderBy',
  'addOrderBy',
  'offset',
  'limit',
] as const;

type RecordedMethod = (typeof RECORDED_METHODS)[number];

/** Every chain method is a present `jest.Mock`, plus the named terminals. */
type RecordingQueryBuilder<Terminal extends string = never> = Record<
  RecordedMethod | Terminal,
  jest.Mock
>;

/** A query builder whose every chain method records its call and returns the
 *  builder itself, with the terminal methods overridable per test. */
function recordingQueryBuilder<Terminal extends string = never>(
  terminals: Record<Terminal, jest.Mock> = {} as Record<Terminal, jest.Mock>,
): RecordingQueryBuilder<Terminal> {
  const queryBuilder = { ...terminals } as RecordingQueryBuilder<Terminal>;
  for (const method of RECORDED_METHODS) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  return queryBuilder;
}

function andWhereCall(
  queryBuilder: Pick<RecordingQueryBuilder, 'andWhere'>,
  fragment: string,
): [string, Record<string, unknown> | undefined] | undefined {
  return (
    queryBuilder.andWhere.mock.calls as [
      string,
      Record<string, unknown> | undefined,
    ][]
  ).find(([clause]) => clause.includes(fragment));
}

const VIEWER_ID = 'viewer';
const TOP_LEVEL_COMMUNITY = { id: 'community-1', parentId: null };
const SPACE = { id: 'space-1', parentId: 'parent-1' };
const LIVE_INVITE_SQL =
  'SELECT 1 FROM "community_invites" "candidate_invite" WHERE live';
const LIVE_INVITE_PARAMETERS = {
  candidateCommunityId: 'community-1',
  liveInvitePendingStatus: 'pending',
};

describe('community-invite-candidates', () => {
  let candidateQuery: RecordingQueryBuilder<'getManyAndCount'>;
  let liveInviteQuery: RecordingQueryBuilder<'getQuery' | 'getParameters'>;
  let profiles: { createQueryBuilder: jest.Mock };
  let invites: { createQueryBuilder: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };

  function sources() {
    return {
      profiles: profiles as unknown as Repository<Profile>,
      invites: invites as unknown as Repository<CommunityInvite>,
      blockFilter: blockFilter as unknown as BlockFilterService,
    };
  }

  beforeEach(() => {
    jest.resetAllMocks();
    candidateQuery = recordingQueryBuilder({
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });
    liveInviteQuery = recordingQueryBuilder({
      getQuery: jest.fn().mockReturnValue(LIVE_INVITE_SQL),
      getParameters: jest.fn().mockReturnValue(LIVE_INVITE_PARAMETERS),
    });
    mockedWhereInviteIsLive.mockImplementation((queryBuilder) => queryBuilder);
    profiles = { createQueryBuilder: jest.fn(() => candidateQuery) };
    invites = { createQueryBuilder: jest.fn(() => liveInviteQuery) };
    blockFilter = {
      excludeBlocked: jest.fn((queryBuilder: unknown) => queryBuilder),
    };
  });

  it('starts from the viewer accepted connections, active non-system accounts only, never the viewer', () => {
    buildInviteCandidatesQuery(sources(), TOP_LEVEL_COMMUNITY, VIEWER_ID, '');

    expect(profiles.createQueryBuilder).toHaveBeenCalledWith('other');
    expect(candidateQuery.setParameter).toHaveBeenCalledWith(
      'viewerUserId',
      VIEWER_ID,
    );
    const [connectionJoin] = candidateQuery.innerJoin.mock.calls as [
      unknown,
      string,
      string,
    ][];
    expect(connectionJoin?.[1]).toBe('connection');
    expect(connectionJoin?.[2]).toContain(
      'CASE WHEN "connection"."requester_id" = :viewerUserId',
    );
    expect(candidateQuery.where).toHaveBeenCalledWith(
      expect.stringContaining('"connection"."addressee_id" = :viewerUserId'),
    );
    expect(candidateQuery.andWhere).toHaveBeenCalledWith(
      '"connection"."status" = :candidateAcceptedStatus',
      { candidateAcceptedStatus: ConnectionStatus.Accepted },
    );
    expect(candidateQuery.andWhere).toHaveBeenCalledWith(
      '"other"."user_id" <> :viewerUserId',
    );
    expect(candidateQuery.andWhere).toHaveBeenCalledWith(
      '"candidate_user"."status" = :candidateActiveUserStatus',
      { candidateActiveUserStatus: UserStatus.Active },
    );
    expect(candidateQuery.andWhere).toHaveBeenCalledWith(
      '"candidate_user"."is_system" = false',
    );
  });

  it('leaves out roster members, live bans, pending requests and blocks for a top-level community', () => {
    buildInviteCandidatesQuery(sources(), TOP_LEVEL_COMMUNITY, VIEWER_ID, '');

    expect(andWhereCall(candidateQuery, '"candidate_roster"')?.[1]).toEqual({
      candidateCommunityId: TOP_LEVEL_COMMUNITY.id,
    });
    const banCall = andWhereCall(candidateQuery, '"candidate_ban"');
    expect(banCall?.[0]).toContain('"candidate_ban"."expires_at" IS NULL');
    expect(banCall?.[0]).toContain('"candidate_ban"."expires_at" > now()');
    expect(banCall?.[1]).toEqual({
      candidateBanCommunityIds: [TOP_LEVEL_COMMUNITY.id],
    });
    expect(andWhereCall(candidateQuery, '"candidate_request"')?.[1]).toEqual({
      candidatePendingRequestStatus: JoinRequestStatus.Pending,
    });
    expect(
      andWhereCall(candidateQuery, '"candidate_parent_roster"'),
    ).toBeUndefined();
    expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
      candidateQuery,
      VIEWER_ID,
      '"other"."user_id"',
    );
  });

  it('for a space, also requires the parent roster and honours a parent ban', () => {
    buildInviteCandidatesQuery(sources(), SPACE, VIEWER_ID, '');

    expect(andWhereCall(candidateQuery, '"candidate_ban"')?.[1]).toEqual({
      candidateBanCommunityIds: [SPACE.id, SPACE.parentId],
    });
    const parentRosterCall = andWhereCall(
      candidateQuery,
      '"candidate_parent_roster"',
    );
    expect(parentRosterCall?.[0]).toMatch(/^EXISTS/);
    expect(parentRosterCall?.[1]).toEqual({
      candidateParentCommunityId: SPACE.parentId,
    });
  });

  it('leaves out live invitations through the shared liveness predicate', () => {
    buildInviteCandidatesQuery(sources(), TOP_LEVEL_COMMUNITY, VIEWER_ID, '');

    expect(invites.createQueryBuilder).toHaveBeenCalledWith('candidate_invite');
    expect(liveInviteQuery.where).toHaveBeenCalledWith(
      '"candidate_invite"."community_id" = :candidateCommunityId',
      { candidateCommunityId: TOP_LEVEL_COMMUNITY.id },
    );
    expect(liveInviteQuery.andWhere).toHaveBeenCalledWith(
      '"candidate_invite"."invited_user_id" = "other"."user_id"',
    );
    expect(mockedWhereInviteIsLive).toHaveBeenCalledWith(
      liveInviteQuery,
      'candidate_invite',
    );
    expect(candidateQuery.andWhere).toHaveBeenCalledWith(
      `NOT EXISTS (${LIVE_INVITE_SQL})`,
    );
    expect(candidateQuery.setParameters).toHaveBeenCalledWith(
      LIVE_INVITE_PARAMETERS,
    );
  });

  it('searches with one folded, escaped LIKE when a term is given', () => {
    buildInviteCandidatesQuery(
      sources(),
      TOP_LEVEL_COMMUNITY,
      VIEWER_ID,
      '50%_off',
    );

    const searchCall = andWhereCall(candidateQuery, 'LIKE');
    expect(searchCall?.[0]).toContain('translate(lower(');
    expect(searchCall?.[0]).toContain("ESCAPE '\\'");
    expect(searchCall?.[1]).toEqual({ searchPattern: '%50\\%\\_off%' });
  });

  it('adds no search clause for an empty term', () => {
    buildInviteCandidatesQuery(sources(), TOP_LEVEL_COMMUNITY, VIEWER_ID, '');

    expect(andWhereCall(candidateQuery, 'LIKE')).toBeUndefined();
  });

  it('orders by most recently connected with a stable tiebreak', () => {
    buildInviteCandidatesQuery(sources(), TOP_LEVEL_COMMUNITY, VIEWER_ID, '');

    expect(candidateQuery.orderBy).toHaveBeenCalledWith(
      '"connection"."responded_at"',
      'DESC',
      'NULLS LAST',
    );
    expect(candidateQuery.addOrderBy).toHaveBeenCalledWith(
      '"connection"."id"',
      'ASC',
    );
  });

  it('pages with offset and limit and returns gated member refs with the true total', async () => {
    candidateQuery.getManyAndCount.mockResolvedValue([
      [
        {
          userId: 'user-hidden-photo',
          slug: 'hidden-photo',
          firstName: 'Hana',
          lastName: 'Hidden',
          pronouns: 'she/her',
          avatarUrl: 'avatars/hidden.jpg',
          photoVisible: false,
        },
        {
          userId: 'user-no-photo',
          slug: 'no-photo',
          firstName: 'Noa',
          lastName: 'Plain',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ],
      43,
    ]);

    const result = await listInviteCandidates(
      sources(),
      TOP_LEVEL_COMMUNITY,
      VIEWER_ID,
      '',
      3,
    );

    expect(candidateQuery.offset).toHaveBeenCalledWith(2 * PAGE_SIZE);
    expect(candidateQuery.limit).toHaveBeenCalledWith(PAGE_SIZE);
    expect(result).toEqual({
      items: [
        {
          slug: 'hidden-photo',
          firstName: 'Hana',
          lastName: 'Hidden',
          pronouns: 'she/her',
          // The photo gate applies: a hidden face never reaches the panel.
          avatarUrl: null,
        },
        {
          slug: 'no-photo',
          firstName: 'Noa',
          lastName: 'Plain',
          pronouns: null,
          avatarUrl: null,
        },
      ],
      total: 43,
      page: 3,
      pageSize: PAGE_SIZE,
    });
  });
});
