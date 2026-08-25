import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AdminTrustNetworkService } from './admin-trust-network.service';
import {
  buildScenes,
  sceneFor,
  standingFor,
} from './admin-trust-network-response';

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
 *  row — the rest is irrelevant to it and left off deliberately. */
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

describe('AdminTrustNetworkService.getGraph', () => {
  let service: AdminTrustNetworkService;
  let profiles: { count: jest.Mock; find: jest.Mock };
  let users: { find: jest.Mock };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let vouches: { find: jest.Mock };
  let reports: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    profiles = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
    };
    users = { find: jest.fn().mockResolvedValue([]) };
    communityMembers = {
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    vouches = { find: jest.fn().mockResolvedValue([]) };
    reports = { createQueryBuilder: jest.fn(() => makeQueryBuilderStub()) };

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
        { provide: getRepositoryToken(Report), useValue: reports },
      ],
    }).compile();

    service = module.get(AdminTrustNetworkService);
  });

  it("marks a suspended member's node as flagged", async () => {
    const profile = makeProfile({ userId: 'user-a', slug: 'a-member' });
    profiles.count.mockResolvedValue(1);
    profiles.find.mockResolvedValue([profile]);
    users.find.mockResolvedValue([{ id: 'user-a' }]);

    const graph = await service.getGraph();

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.standing).toBe('flagged');
  });

  it('marks a reciprocal active vouch pair as mutual on both edges', async () => {
    const profileA = makeProfile({ userId: 'user-a', slug: 'a-member' });
    const profileB = makeProfile({ userId: 'user-b', slug: 'b-member' });
    profiles.count.mockResolvedValue(2);
    profiles.find.mockResolvedValue([profileA, profileB]);
    vouches.find.mockResolvedValue([
      makeVouch({ id: 'v1', voucherId: 'user-a', voucheeId: 'user-b' }),
      makeVouch({ id: 'v2', voucherId: 'user-b', voucheeId: 'user-a' }),
    ]);

    const graph = await service.getGraph();

    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.mutual)).toBe(true);
  });

  it('surfaces a withdrawn vouch as a non-mutual withdrawn edge', async () => {
    const profileA = makeProfile({ userId: 'user-a', slug: 'a-member' });
    const profileB = makeProfile({ userId: 'user-b', slug: 'b-member' });
    profiles.count.mockResolvedValue(2);
    profiles.find.mockResolvedValue([profileA, profileB]);
    vouches.find.mockResolvedValue([
      makeVouch({
        id: 'v1',
        voucherId: 'user-a',
        voucheeId: 'user-b',
        withdrawnAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ]);

    const graph = await service.getGraph();

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.withdrawn).toBe(true);
    expect(graph.edges[0]!.mutual).toBe(false);
  });

  it('drops an edge whose endpoint fell outside the node cap', async () => {
    const profileA = makeProfile({ userId: 'user-a', slug: 'a-member' });
    profiles.count.mockResolvedValue(1);
    profiles.find.mockResolvedValue([profileA]);
    // `user-c` was never returned by `profiles.find` — simulates an endpoint
    // beyond `MAX_NODES`.
    vouches.find.mockResolvedValue([
      makeVouch({ id: 'v1', voucherId: 'user-a', voucheeId: 'user-c' }),
    ]);

    const graph = await service.getGraph();

    expect(graph.edges).toHaveLength(0);
  });

  it('reports truncated when more members exist than were returned', async () => {
    const profileA = makeProfile({ userId: 'user-a', slug: 'a-member' });
    profiles.count.mockResolvedValue(3);
    profiles.find.mockResolvedValue([profileA]);

    const graph = await service.getGraph();

    expect(graph.truncated).toBe(true);
  });
});
