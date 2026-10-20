import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import type {
  AssessmentMemberInput,
  MemberAssessment,
  TrustAssessment,
} from './admin-trust-network-assessment';
import { AdminTrustNetworkAssessmentService } from './admin-trust-network-assessment.service';
import { AdminTrustNetworkService } from './admin-trust-network.service';
import {
  buildScenes,
  sceneFor,
  standingFor,
} from './admin-trust-network-response';
import {
  BFS_MAX_DEPTH,
  MAX_NODES,
  selectNodeUserIds,
} from './admin-trust-network-selection';

describe('standingFor', () => {
  it('flags a suspended member', () => {
    expect(
      standingFor({
        suspended: true,
        frozen: false,
        openReportCount: 0,
        verified: true,
      }),
    ).toBe('flagged');
  });
  it('flags a member with 2+ open reports', () => {
    expect(
      standingFor({
        suspended: false,
        frozen: false,
        openReportCount: 2,
        verified: true,
      }),
    ).toBe('flagged');
  });
  it('warns a member with exactly 1 open report', () => {
    expect(
      standingFor({
        suspended: false,
        frozen: false,
        openReportCount: 1,
        verified: true,
      }),
    ).toBe('warned');
  });
  it('marks an unverified, unreported member as new', () => {
    expect(
      standingFor({
        suspended: false,
        frozen: false,
        openReportCount: 0,
        verified: false,
      }),
    ).toBe('new');
  });
  it('marks a verified, unreported member as trusted', () => {
    expect(
      standingFor({
        suspended: false,
        frozen: false,
        openReportCount: 0,
        verified: true,
      }),
    ).toBe('trusted');
  });
});

describe('sceneFor', () => {
  it('returns null with no memberships', () => {
    expect(sceneFor([])).toBeNull();
  });
  it('picks the highest role', () => {
    const scene = sceneFor([
      {
        communityId: 'c1',
        communityName: 'A',
        role: RosterRole.Member,
        communitySize: 100,
      },
      {
        communityId: 'c2',
        communityName: 'B',
        role: RosterRole.Owner,
        communitySize: 3,
      },
    ]);
    expect(scene?.id).toBe('c2');
  });
  it('tie-breaks equal roles by size desc', () => {
    const scene = sceneFor([
      {
        communityId: 'c1',
        communityName: 'A',
        role: RosterRole.Member,
        communitySize: 10,
      },
      {
        communityId: 'c2',
        communityName: 'B',
        role: RosterRole.Member,
        communitySize: 50,
      },
    ]);
    expect(scene?.id).toBe('c2');
  });
});

describe('buildScenes', () => {
  it('assigns a stable color per distinct scene, sorted by id', () => {
    const scenes = buildScenes(
      new Map([
        ['c2', 'B'],
        ['c1', 'A'],
      ]),
    );
    expect(scenes.map((s) => s.id)).toEqual(['c1', 'c2']);
    expect(scenes[0]!.color).not.toBe(scenes[1]!.color);
  });
});

/** Only the fields `AdminTrustNetworkService` actually reads off a `Profile`
 *  row. The rest is irrelevant to it and left off deliberately. */
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-ines',
    slug: 'ines-martins',
    firstName: 'Inês',
    lastName: 'Martins',
    pronouns: 'she/her',
    avatarUrl: null,
    verified: true,
    privateNetwork: false,
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Profile;
}

function makeVouch(overrides: Partial<Vouch> = {}): Vouch {
  return {
    id: 'vouch-1',
    voucherId: 'user-a',
    voucheeId: 'user-b',
    note: null,
    relationships: ['friends'],
    anonymous: false,
    withdrawnAt: null,
    reactivatedAt: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeMemberAssessment(
  overrides: Partial<MemberAssessment> = {},
): MemberAssessment {
  return {
    accountKind: 'member',
    standing: 'trusted',
    ringId: null,
    isolatedBy: [],
    trackRecord: { vouchesGiven: 0, laterFlaggedCount: 0 },
    activeInboundCount: 0,
    activeOutboundCount: 0,
    ...overrides,
  };
}

function makeAssessedMember(
  profile: Profile,
  overrides: Partial<AssessmentMemberInput> = {},
): AssessmentMemberInput {
  return {
    userId: profile.userId,
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`.trim(),
    verified: profile.verified,
    joinedAt: profile.joinedAt,
    role: UserRole.Member,
    isSystem: false,
    isSuspended: false,
    isDeactivated: false,
    invitedByUserId: null,
    openReportCount: 0,
    ...overrides,
  };
}

function makeAssessment(
  overrides: Partial<TrustAssessment> = {},
): TrustAssessment {
  return {
    generatedAt: new Date('2026-10-01T00:00:00.000Z'),
    platformStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    newAccountWindowDays: 30,
    members: new Map(),
    byUserId: new Map(),
    rings: [],
    cases: [],
    ...overrides,
  };
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
  'addOrderBy',
  'limit',
];

/** Stubs the fluent `createQueryBuilder` chain: every builder method returns
 *  the builder itself; `getRawMany` resolves to whatever is passed in
 *  (defaulting to "no rows"), mirroring `admin-members.service.spec.ts`. */
function makeQueryBuilderStub(rawMany: unknown[] = []): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {};
  for (const chainedMethod of CHAINED_BUILDER_METHODS) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rawMany);
  return queryBuilder;
}

/** The ids inside an `In([...])` condition on `key`, or null when absent. */
function inValuesOf(where: unknown, key: string): string[] | null {
  const condition = (where as Record<string, unknown> | undefined)?.[key];
  return condition instanceof FindOperator
    ? (condition.value as string[])
    : null;
}

/** `loadNewestUserIds`: newest-joined first, honouring the NOT IN list and
 *  the limit the service passes. */
function makeNewestProfilesBuilder(allProfiles: Profile[]): QueryBuilderStub {
  const queryBuilder = makeQueryBuilderStub();
  let excludedUserIds: string[] = [];
  let take = Number.MAX_SAFE_INTEGER;
  queryBuilder.where = jest.fn(
    (_clause: string, parameters?: { excludeUserIds?: string[] }) => {
      excludedUserIds = parameters?.excludeUserIds ?? [];
      return queryBuilder;
    },
  );
  queryBuilder.limit = jest.fn((limit: number) => {
    take = limit;
    return queryBuilder;
  });
  queryBuilder.getRawMany = jest.fn(() =>
    Promise.resolve(
      allProfiles
        .filter((profile) => !excludedUserIds.includes(profile.userId))
        .sort(
          (first, second) =>
            second.joinedAt.getTime() - first.joinedAt.getTime(),
        )
        .slice(0, take)
        .map((profile) => ({ userId: profile.userId })),
    ),
  );
  return queryBuilder;
}

/** `loadNeighbourUserIds`: every vouch row touching the frontier. */
function makeNeighbourVouchBuilder(allVouches: Vouch[]): QueryBuilderStub {
  const queryBuilder = makeQueryBuilderStub();
  let frontier: string[] = [];
  queryBuilder.where = jest.fn(
    (_clause: string, parameters?: { frontier?: string[] }) => {
      frontier = parameters?.frontier ?? [];
      return queryBuilder;
    },
  );
  queryBuilder.getRawMany = jest.fn(() =>
    Promise.resolve(
      allVouches
        .filter(
          (vouch) =>
            frontier.includes(vouch.voucherId) ||
            frontier.includes(vouch.voucheeId),
        )
        .map((vouch) => ({
          voucherId: vouch.voucherId,
          voucheeId: vouch.voucheeId,
        })),
    ),
  );
  return queryBuilder;
}

/** Every id gets a joinedAt, so the profile filter keeps them all. */
function joinedAtForEvery(userIds: string[]): Promise<Map<string, Date>> {
  return Promise.resolve(
    new Map(
      userIds.map((userId) => [userId, new Date('2026-01-01T00:00:00.000Z')]),
    ),
  );
}

describe('selectNodeUserIds', () => {
  it('returns the newest members when there is no focus', async () => {
    const loadNewestUserIds = jest.fn().mockResolvedValue(['user-new']);
    const selected = await selectNodeUserIds({
      focusUserId: null,
      loadNeighbourUserIds: jest.fn(),
      loadJoinedAtByUserId: jest.fn(),
      loadNewestUserIds,
    });
    expect(selected).toEqual(['user-new']);
    expect(loadNewestUserIds).toHaveBeenCalledWith([], MAX_NODES);
  });

  it('puts the focus first, then BFS levels, then the newest fill', async () => {
    const neighboursByUserId: Record<string, string[]> = {
      'user-focus': ['user-one-hop'],
      'user-one-hop': ['user-focus', 'user-two-hops'],
    };
    const selected = await selectNodeUserIds({
      focusUserId: 'user-focus',
      loadNeighbourUserIds: (frontier) =>
        Promise.resolve(
          frontier.flatMap((userId) => neighboursByUserId[userId] ?? []),
        ),
      loadJoinedAtByUserId: joinedAtForEvery,
      loadNewestUserIds: () => Promise.resolve(['user-newest']),
    });
    expect(selected).toEqual([
      'user-focus',
      'user-one-hop',
      'user-two-hops',
      'user-newest',
    ]);
  });

  it('trims an overflowing level to its newest-joined members', async () => {
    const levelUserIds = Array.from(
      { length: MAX_NODES + 10 },
      (_unused, index) => `user-${String(index).padStart(4, '0')}`,
    );
    const joinedAtByUserId = new Map(
      levelUserIds.map((userId, index) => [
        userId,
        new Date(Date.UTC(2026, 0, 1) + index * 60_000),
      ]),
    );
    const loadNewestUserIds = jest.fn().mockResolvedValue([]);
    const selected = await selectNodeUserIds({
      focusUserId: 'user-focus',
      loadNeighbourUserIds: () => Promise.resolve(levelUserIds),
      loadJoinedAtByUserId: () => Promise.resolve(joinedAtByUserId),
      loadNewestUserIds,
    });
    expect(selected).toHaveLength(MAX_NODES);
    expect(selected[0]).toBe('user-focus');
    // The 11 oldest members of the level are the ones left out.
    expect(selected).not.toContain('user-0000');
    expect(selected).not.toContain('user-0010');
    expect(selected).toContain('user-0011');
    expect(selected).toContain(`user-${String(MAX_NODES + 9)}`);
    expect(loadNewestUserIds).not.toHaveBeenCalled();
  });

  it('drops neighbour ids with no profile before counting capacity', async () => {
    const selected = await selectNodeUserIds({
      focusUserId: 'user-focus',
      loadNeighbourUserIds: (frontier) =>
        Promise.resolve(
          frontier.includes('user-focus')
            ? ['user-deleted', 'user-friend']
            : [],
        ),
      loadJoinedAtByUserId: () =>
        Promise.resolve(
          new Map([['user-friend', new Date('2026-01-01T00:00:00.000Z')]]),
        ),
      loadNewestUserIds: () => Promise.resolve([]),
    });
    expect(selected).toEqual(['user-focus', 'user-friend']);
  });

  it(`stops after ${BFS_MAX_DEPTH} hops`, async () => {
    const loadNeighbourUserIds = jest.fn((frontier: string[]) =>
      Promise.resolve(frontier.map((userId) => `${userId}+`)),
    );
    const selected = await selectNodeUserIds({
      focusUserId: 'user',
      loadNeighbourUserIds,
      loadJoinedAtByUserId: joinedAtForEvery,
      loadNewestUserIds: () => Promise.resolve([]),
    });
    expect(loadNeighbourUserIds).toHaveBeenCalledTimes(BFS_MAX_DEPTH);
    expect(selected).toEqual(['user', 'user+', 'user++', 'user+++']);
  });
});

describe('AdminTrustNetworkService', () => {
  let service: AdminTrustNetworkService;
  let allProfiles: Profile[];
  let allVouches: Vouch[];
  let profiles: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let users: { find: jest.Mock };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let vouches: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let invites: { find: jest.Mock };
  let joinRequests: { find: jest.Mock };
  let assessmentService: { getAssessment: jest.Mock };

  beforeEach(async () => {
    allProfiles = [];
    allVouches = [];
    profiles = {
      count: jest.fn(() => Promise.resolve(allProfiles.length)),
      find: jest.fn((options?: { where?: unknown }) => {
        const userIds = inValuesOf(options?.where, 'userId');
        return Promise.resolve(
          userIds
            ? allProfiles.filter((profile) => userIds.includes(profile.userId))
            : allProfiles,
        );
      }),
      findOne: jest.fn((options: { where: { slug: string } }) =>
        Promise.resolve(
          allProfiles.find((profile) => profile.slug === options.where.slug) ??
            null,
        ),
      ),
      createQueryBuilder: jest.fn(() => makeNewestProfilesBuilder(allProfiles)),
    };
    users = { find: jest.fn().mockResolvedValue([]) };
    communityMembers = {
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    vouches = {
      find: jest.fn(() => Promise.resolve(allVouches)),
      createQueryBuilder: jest.fn(() => makeNeighbourVouchBuilder(allVouches)),
    };
    invites = { find: jest.fn().mockResolvedValue([]) };
    joinRequests = { find: jest.fn().mockResolvedValue([]) };
    assessmentService = {
      getAssessment: jest.fn().mockResolvedValue(makeAssessment()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTrustNetworkService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        { provide: getRepositoryToken(Invite), useValue: invites },
        {
          provide: getRepositoryToken(PlatformJoinRequest),
          useValue: joinRequests,
        },
        {
          provide: AdminTrustNetworkAssessmentService,
          useValue: assessmentService,
        },
      ],
    }).compile();

    service = module.get(AdminTrustNetworkService);
  });

  describe('getGraph', () => {
    it("reads a node's standing and openReportCount from the assessment", async () => {
      const profile = makeProfile({ userId: 'user-a', slug: 'a-member' });
      allProfiles = [profile];
      assessmentService.getAssessment.mockResolvedValue(
        makeAssessment({
          members: new Map([
            ['user-a', makeAssessedMember(profile, { openReportCount: 3 })],
          ]),
          byUserId: new Map([
            ['user-a', makeMemberAssessment({ standing: 'flagged' })],
          ]),
        }),
      );

      const graph = await service.getGraph();

      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0]!.standing).toBe('flagged');
      expect(graph.nodes[0]!.openReportCount).toBe(3);
    });

    it('marks a reciprocal active vouch pair as mutual on both edges', async () => {
      allProfiles = [
        makeProfile({ userId: 'user-a', slug: 'a-member' }),
        makeProfile({ userId: 'user-b', slug: 'b-member' }),
      ];
      allVouches = [
        makeVouch({ id: 'v1', voucherId: 'user-a', voucheeId: 'user-b' }),
        makeVouch({ id: 'v2', voucherId: 'user-b', voucheeId: 'user-a' }),
      ];

      const graph = await service.getGraph();

      expect(graph.edges).toHaveLength(2);
      expect(graph.edges.every((edge) => edge.mutual)).toBe(true);
    });

    it('surfaces a withdrawn vouch as a non-mutual withdrawn edge', async () => {
      allProfiles = [
        makeProfile({ userId: 'user-a', slug: 'a-member' }),
        makeProfile({ userId: 'user-b', slug: 'b-member' }),
      ];
      allVouches = [
        makeVouch({
          id: 'v1',
          voucherId: 'user-a',
          voucheeId: 'user-b',
          withdrawnAt: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ];

      const graph = await service.getGraph();

      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.withdrawn).toBe(true);
      expect(graph.edges[0]!.mutual).toBe(false);
    });

    it('drops an edge whose endpoint fell outside the node cap', async () => {
      allProfiles = [makeProfile({ userId: 'user-a', slug: 'a-member' })];
      // `user-c` has no profile row: simulates an endpoint beyond `MAX_NODES`.
      allVouches = [
        makeVouch({ id: 'v1', voucherId: 'user-a', voucheeId: 'user-c' }),
      ];

      const graph = await service.getGraph();

      expect(graph.edges).toHaveLength(0);
    });

    it('reports truncated when more members exist than were returned', async () => {
      allProfiles = [makeProfile({ userId: 'user-a', slug: 'a-member' })];
      profiles.count.mockResolvedValue(3);

      const graph = await service.getGraph();

      expect(graph.truncated).toBe(true);
    });

    it('scopes the membership scene lookup to top-level communities, excluding spaces', async () => {
      allProfiles = [makeProfile({ userId: 'user-a', slug: 'a-member' })];

      await service.getGraph();

      // The first `communityMembers.createQueryBuilder` call is the membership
      // rows read (the second is the community-size tie-break query, which does
      // not join `communities` at all and so carries no `parent_id` predicate).
      const membershipQueryBuilder = communityMembers.createQueryBuilder.mock
        .results[0]?.value as QueryBuilderStub;
      expect(membershipQueryBuilder.andWhere).toHaveBeenCalledWith(
        'community.parent_id IS NULL',
      );
    });

    it('lists every membership primary first and covers each one in scenes', async () => {
      allProfiles = [makeProfile({ userId: 'user-a', slug: 'a-member' })];
      communityMembers.createQueryBuilder
        .mockImplementationOnce(() =>
          makeQueryBuilderStub([
            {
              userId: 'user-a',
              role: RosterRole.Member,
              communityId: 'community-big',
              communityName: 'Big',
            },
            {
              userId: 'user-a',
              role: RosterRole.Owner,
              communityId: 'community-small',
              communityName: 'Small',
            },
          ]),
        )
        .mockImplementationOnce(() =>
          makeQueryBuilderStub([
            { communityId: 'community-big', count: '90' },
            { communityId: 'community-small', count: '4' },
          ]),
        );

      const graph = await service.getGraph();

      expect(graph.nodes[0]!.sceneIds).toEqual([
        'community-small',
        'community-big',
      ]);
      expect(graph.nodes[0]!.sceneId).toBe('community-small');
      expect(graph.scenes.map((scene) => scene.id).sort()).toEqual([
        'community-big',
        'community-small',
      ]);
    });

    it('includes an old neighbour of the focus even when 500 newer profiles exist', async () => {
      const focus = makeProfile({
        userId: 'user-focus',
        slug: 'old-focus',
        joinedAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      const oldFriend = makeProfile({
        userId: 'user-old-friend',
        slug: 'old-friend',
        joinedAt: new Date('2020-02-01T00:00:00.000Z'),
      });
      const newerProfiles = Array.from(
        { length: MAX_NODES },
        (_unused, index) =>
          makeProfile({
            userId: `user-new-${index}`,
            slug: `new-${index}`,
            joinedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
          }),
      );
      allProfiles = [focus, oldFriend, ...newerProfiles];
      allVouches = [
        makeVouch({
          id: 'v-old',
          voucherId: 'user-old-friend',
          voucheeId: 'user-focus',
          withdrawnAt: new Date('2021-01-01T00:00:00.000Z'),
        }),
      ];

      const graph = await service.getGraph({ focus: 'old-focus' });

      expect(graph.nodes).toHaveLength(MAX_NODES);
      expect(graph.nodes[0]!.slug).toBe('old-focus');
      expect(graph.nodes.map((node) => node.slug)).toContain('old-friend');
      expect(graph.truncated).toBe(true);
    });

    it("reads joinPath.kind 'founder' for a founding member with no inviter", async () => {
      const profile = makeProfile({ userId: 'user-a', slug: 'a-member' });
      allProfiles = [profile];
      users.find.mockResolvedValue([{ id: 'user-a', invitedBy: null }]);
      assessmentService.getAssessment.mockResolvedValue(
        makeAssessment({
          members: new Map([['user-a', makeAssessedMember(profile)]]),
          byUserId: new Map([
            ['user-a', makeMemberAssessment({ accountKind: 'founder' })],
          ]),
        }),
      );

      const graph = await service.getGraph();

      expect(graph.nodes[0]!.accountKind).toBe('founder');
      expect(graph.nodes[0]!.joinPath).toEqual({
        kind: 'founder',
        bySlug: null,
        byName: null,
        at: profile.joinedAt.toISOString(),
      });
    });

    it("reads joinPath.kind 'application' with the reviewer for an approved request", async () => {
      const reviewer = makeProfile({ userId: 'user-a', slug: 'a-member' });
      const applicant = makeProfile({ userId: 'user-b', slug: 'b-member' });
      const reviewedAt = new Date('2026-04-01T00:00:00.000Z');
      allProfiles = [reviewer, applicant];
      users.find.mockResolvedValue([
        { id: 'user-a', invitedBy: null },
        { id: 'user-b', invitedBy: 'user-a' },
      ]);
      invites.find.mockResolvedValue([
        {
          id: 'invite-1',
          acceptedBy: 'user-b',
          usedAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ]);
      joinRequests.find.mockResolvedValue([
        {
          id: 'request-1',
          inviteId: 'invite-1',
          reviewedBy: 'user-a',
          reviewedAt,
        },
      ]);

      const graph = await service.getGraph();

      const applicantNode = graph.nodes.find(
        (node) => node.slug === 'b-member',
      );
      expect(applicantNode?.joinPath).toEqual({
        kind: 'application',
        bySlug: 'a-member',
        byName: 'Inês Martins',
        at: reviewedAt.toISOString(),
      });
    });

    it("reads joinPath.kind 'invite' for a member with an inviter and no application", async () => {
      allProfiles = [
        makeProfile({ userId: 'user-a', slug: 'a-member' }),
        makeProfile({ userId: 'user-b', slug: 'b-member' }),
      ];
      users.find.mockResolvedValue([
        { id: 'user-a', invitedBy: null },
        { id: 'user-b', invitedBy: 'user-a' },
      ]);

      const graph = await service.getGraph();

      const inviteeNode = graph.nodes.find((node) => node.slug === 'b-member');
      expect(inviteeNode?.joinPath.kind).toBe('invite');
      expect(inviteeNode?.joinPath.bySlug).toBe('a-member');
      const unknownNode = graph.nodes.find((node) => node.slug === 'a-member');
      expect(unknownNode?.joinPath.kind).toBe('unknown');
    });

    it('maps rings, isolation and cases from the assessment to slugs and names', async () => {
      const ringOne = makeProfile({ userId: 'user-r1', slug: 'r1' });
      const ringTwo = makeProfile({ userId: 'user-r2', slug: 'r2' });
      const ringOutside = makeProfile({ userId: 'user-r3', slug: 'r3' });
      const lone = makeProfile({ userId: 'user-lone', slug: 'lone' });
      allProfiles = [ringOne, ringTwo, lone];
      const ringId = 'ring:r1';
      assessmentService.getAssessment.mockResolvedValue(
        makeAssessment({
          members: new Map(
            [ringOne, ringTwo, ringOutside, lone].map((profile) => [
              profile.userId,
              makeAssessedMember(profile),
            ]),
          ),
          byUserId: new Map([
            ['user-r1', makeMemberAssessment({ ringId })],
            ['user-r2', makeMemberAssessment({ ringId })],
            [
              'user-lone',
              makeMemberAssessment({
                isolatedBy: [{ userId: 'user-r1', reason: 'ring' }],
              }),
            ],
          ]),
          rings: [
            {
              id: ringId,
              memberUserIds: ['user-r3', 'user-r1', 'user-r2'],
              firstJoinedAt: new Date('2026-05-01T00:00:00.000Z'),
              lastJoinedAt: new Date('2026-05-01T02:00:00.000Z'),
              sharedVoucherUserIds: [],
            },
          ],
          cases: [
            {
              id: ringId,
              kind: 'ring',
              subjectUserId: 'user-r1',
              ringId,
              memberCount: 3,
              weakVoucherCount: 0,
              openReportCount: 0,
              windowHours: 2,
              score: 3003,
            },
          ],
        }),
      );

      const graph = await service.getGraph();

      const ringNode = graph.nodes.find((node) => node.slug === 'r1');
      expect(ringNode?.inRing).toBe(true);
      expect(ringNode?.ringId).toBe(ringId);
      expect(graph.rings).toHaveLength(1);
      expect(graph.rings[0]!.memberSlugs).toEqual(['r1', 'r2', 'r3']);
      expect(graph.rings[0]!.memberCount).toBe(3);
      const loneNode = graph.nodes.find((node) => node.slug === 'lone');
      expect(loneNode?.isolatedBy).toEqual([
        { slug: 'r1', name: 'Inês Martins', reason: 'ring' },
      ]);
      expect(graph.cases[0]!.subjectSlug).toBe('r1');
      expect(graph.openCaseCount).toBe(1);
    });
  });

  describe('getSummary', () => {
    it("returns the top case's subject slug and the open case count", async () => {
      const flagged = makeProfile({ userId: 'user-f', slug: 'flagged-one' });
      const isolated = makeProfile({ userId: 'user-i', slug: 'isolated-one' });
      assessmentService.getAssessment.mockResolvedValue(
        makeAssessment({
          members: new Map([
            ['user-f', makeAssessedMember(flagged)],
            ['user-i', makeAssessedMember(isolated)],
          ]),
          cases: [
            {
              id: 'flagged:flagged-one',
              kind: 'flagged',
              subjectUserId: 'user-f',
              ringId: null,
              memberCount: 1,
              weakVoucherCount: 0,
              openReportCount: 2,
              windowHours: null,
              score: 2020,
            },
            {
              id: 'isolated:isolated-one',
              kind: 'isolated',
              subjectUserId: 'user-i',
              ringId: null,
              memberCount: 1,
              weakVoucherCount: 1,
              openReportCount: 0,
              windowHours: null,
              score: 1001,
            },
          ],
        }),
      );

      await expect(service.getSummary()).resolves.toEqual({
        openCaseCount: 2,
        entrySlug: 'flagged-one',
      });
    });

    it('falls back to the earliest-joined staff or founder slug', async () => {
      const founder = makeProfile({
        userId: 'user-founder',
        slug: 'founder',
        joinedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      const staff = makeProfile({
        userId: 'user-staff',
        slug: 'staff',
        joinedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const system = makeProfile({
        userId: 'user-system',
        slug: 'system',
        joinedAt: new Date('2025-12-01T00:00:00.000Z'),
      });
      assessmentService.getAssessment.mockResolvedValue(
        makeAssessment({
          members: new Map(
            [founder, staff, system].map((profile) => [
              profile.userId,
              makeAssessedMember(profile),
            ]),
          ),
          byUserId: new Map([
            ['user-founder', makeMemberAssessment({ accountKind: 'founder' })],
            ['user-staff', makeMemberAssessment({ accountKind: 'staff' })],
            ['user-system', makeMemberAssessment({ accountKind: 'system' })],
          ]),
        }),
      );

      await expect(service.getSummary()).resolves.toEqual({
        openCaseCount: 0,
        entrySlug: 'staff',
      });
    });

    it('returns a null entry slug on an empty platform', async () => {
      await expect(service.getSummary()).resolves.toEqual({
        openCaseCount: 0,
        entrySlug: null,
      });
    });
  });
});
