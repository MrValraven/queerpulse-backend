import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityTarget, In, ObjectLiteral } from 'typeorm';
import { AmbassadorsService } from '../ambassadors/ambassadors.service';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { UsersService } from '../users/users.service';
import { VouchService } from '../vouch/vouch.service';
import {
  AdminMembersService,
  ADMIN_MEMBERS_PAGE_SIZE,
} from './admin-members.service';
import { OfficialMailboxSeatsService } from '../identities/official-mailbox-seats.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-07-21T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(FIXED_NOW.getTime() - days * DAY_MS);
}

/** Only the fields this service actually reads off a `Profile` row — the rest
 *  is irrelevant to it and left off deliberately. */
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-ines',
    slug: 'ines-martins',
    firstName: 'Inês',
    lastName: 'Martins',
    pronouns: 'she/her',
    tagline: 'Softly, together.',
    avatarUrl: null,
    verified: true,
    joinedAt: daysAgo(200),
    ...overrides,
  } as unknown as Profile;
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    subjectType: ReportSubjectType.Member,
    subjectId: 'user-ines',
    reasonCode: 'harassment',
    detail: 'Repeated targeting in the thread.',
    anonymous: false,
    contactEmail: null,
    anonymousReporterKey: null,
    evidence: null,
    severity: ReportSeverity.High,
    slaDueAt: daysAgo(-1),
    status: ReportStatus.Open,
    reporterId: 'user-reporter',
    assignedModeratorId: null,
    assignedAt: null,
    resolvedAt: null,
    resolutionActorId: null,
    resolutionAction: null,
    resolutionDuration: null,
    resolutionNote: null,
    resolutionNotified: null,
    createdAt: daysAgo(2),
    ...overrides,
  };
}

type QueryBuilderStub = Record<string, jest.Mock>;

const CHAINED_BUILDER_METHODS = [
  'select',
  'addSelect',
  'from',
  'innerJoin',
  'where',
  'andWhere',
  'groupBy',
  'orderBy',
  'addOrderBy',
  'skip',
  'take',
];

/** Stubs the fluent `createQueryBuilder` chain: every builder method returns
 *  the builder itself; the three possible terminal methods each resolve to
 *  whatever is passed in (defaulting to "no rows"), since which terminal
 *  method a given call site uses depends on the query. */
function makeQueryBuilderStub(
  terminals: {
    getMany?: unknown[];
    getManyAndCount?: [unknown[], number];
    getRawMany?: unknown[];
  } = {},
): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {};
  for (const chainedMethod of CHAINED_BUILDER_METHODS) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(terminals.getMany ?? []);
  queryBuilder.getManyAndCount = jest
    .fn()
    .mockResolvedValue(terminals.getManyAndCount ?? [[], 0]);
  queryBuilder.getRawMany = jest
    .fn()
    .mockResolvedValue(terminals.getRawMany ?? []);
  return queryBuilder;
}

describe('AdminMembersService', () => {
  let service: AdminMembersService;
  let profiles: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let users: { find: jest.Mock; findOne: jest.Mock };
  let vouches: {
    find: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
    // `loadTopVouchers` builds its bounded window query through the repo's
    // EntityManager (`this.vouches.manager.createQueryBuilder()`), so the mock
    // repo needs a `manager` with its own builder stub.
    manager: { createQueryBuilder: jest.Mock };
  };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let reports: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let modAuditLogs: { find: jest.Mock };
  let staffRoles: { find: jest.Mock };
  let vouchService: { getVouchCounts: jest.Mock; getVouchCount: jest.Mock };
  // The last-admin guard counts admins through `UsersService.countAdmins`,
  // inside the demotion's own transaction. Two by default, so an ordinary
  // role change is never the last-admin case.
  let usersService: { countAdmins: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  // ENG-457: losing the `partnerships` grant or the admin tier releases the
  // member's staff seat in the ambassadors circle.
  let ambassadorsService: { releaseStaffSeat: jest.Mock };
  let officialMailboxSeats: { resyncStaff: jest.Mock };

  // The repos as seen through `manager.getRepository(...)` inside
  // `dataSource.transaction` — separate mocks from the top-level injected
  // repos above, since `updateRole`/`grantStaffRole`/`revokeStaffRole` all do
  // their reads/writes through the transactional `EntityManager`, not the
  // constructor-injected repositories.
  let transactionUsers: {
    findOne: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  let transactionStaffRoles: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let transactionAuditLogs: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    users = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    vouches = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
      manager: {
        createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
      },
    };
    communityMembers = {
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    reports = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    modAuditLogs = { find: jest.fn().mockResolvedValue([]) };
    staffRoles = { find: jest.fn().mockResolvedValue([]) };
    vouchService = {
      getVouchCounts: jest.fn().mockResolvedValue(new Map()),
      getVouchCount: jest.fn().mockResolvedValue(0),
    };
    usersService = { countAdmins: jest.fn().mockResolvedValue(2) };
    ambassadorsService = {
      releaseStaffSeat: jest.fn().mockResolvedValue(undefined),
    };
    officialMailboxSeats = {
      resyncStaff: jest.fn().mockResolvedValue(undefined),
    };

    transactionUsers = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
    };
    transactionStaffRoles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    transactionAuditLogs = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
    };

    // `updateRole`/`grantStaffRole`/`revokeStaffRole` are the only methods
    // that open a transaction. This stub runs the callback for real against a
    // fake `EntityManager` whose `getRepository` resolves to whichever of the
    // three transactional repo stubs above matches the entity class asked
    // for — the same three entities every one of those methods touches.
    dataSource = {
      transaction: jest.fn(
        async (
          runInTransaction: (manager: {
            getRepository: (entity: EntityTarget<ObjectLiteral>) => unknown;
          }) => Promise<unknown>,
        ) =>
          runInTransaction({
            getRepository: (entity: EntityTarget<ObjectLiteral>) => {
              if (entity === User) return transactionUsers;
              if (entity === UserStaffRole) return transactionStaffRoles;
              if (entity === ModAuditLog) return transactionAuditLogs;
              const entityName =
                typeof entity === 'function' ? entity.name : 'unknown';
              throw new Error(
                `Unexpected repository requested in transaction stub: ${entityName}`,
              );
            },
          }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMembersService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(ModAuditLog), useValue: modAuditLogs },
        { provide: getRepositoryToken(UserStaffRole), useValue: staffRoles },
        { provide: VouchService, useValue: vouchService },
        { provide: UsersService, useValue: usersService },
        { provide: DataSource, useValue: dataSource },
        { provide: AmbassadorsService, useValue: ambassadorsService },
        {
          provide: OfficialMailboxSeatsService,
          useValue: officialMailboxSeats,
        },
      ],
    }).compile();

    service = module.get(AdminMembersService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('list', () => {
    it('returns a paginated envelope with each row adapted into a card', async () => {
      const profileRow = makeProfile();
      profiles.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getManyAndCount: [[profileRow], 1] }),
      );
      // Every other grouped query is stubbed to "no rows" per the harness
      // note in the task brief — this test only exercises the envelope shape
      // and the vouch-count wiring, not every batched aggregate.
      vouches.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getMany: [] }),
      );
      reports.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getRawMany: [] }),
      );
      communityMembers.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getRawMany: [] }),
      );
      vouchService.getVouchCounts.mockResolvedValue(
        new Map([[profileRow.userId, 3]]),
      );

      const result = await service.list({ page: 1 });

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(ADMIN_MEMBERS_PAGE_SIZE);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        slug: 'ines-martins',
        name: 'Inês Martins',
        initials: 'IM',
        vouchCount: 3,
      });
    });

    it('excludes spaces (subcommunities) from each card’s community names', async () => {
      const profileRow = makeProfile();
      profiles.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getManyAndCount: [[profileRow], 1] }),
      );
      vouches.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getMany: [] }),
      );
      reports.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getRawMany: [] }),
      );
      const membershipQueryBuilder = makeQueryBuilderStub({ getRawMany: [] });
      communityMembers.createQueryBuilder.mockReturnValue(
        membershipQueryBuilder,
      );
      vouchService.getVouchCounts.mockResolvedValue(new Map());

      await service.list({ page: 1 });

      expect(membershipQueryBuilder.andWhere).toHaveBeenCalledWith(
        'community.parent_id IS NULL',
      );
    });

    it('matches a name search on the server, folded and with LIKE wildcards escaped', async () => {
      const profileQueryBuilder = makeQueryBuilderStub({
        getManyAndCount: [[], 0],
      });
      profiles.createQueryBuilder.mockReturnValue(profileQueryBuilder);

      await service.list({ q: '  Joao_%  ' });

      const andWhereCalls = (profileQueryBuilder.andWhere?.mock.calls ??
        []) as [string, unknown][];
      const searchCall = andWhereCalls.find(([clause]) =>
        clause.includes(':searchTerm'),
      );
      expect(searchCall).toBeDefined();
      const [clause, parameters] = searchCall ?? ['', undefined];
      expect(clause).toContain('"profile"."first_name"');
      expect(clause).toContain('"profile"."pronouns"');
      expect(clause).toContain('translate(');
      expect(clause).toContain("ESCAPE '\\'");
      expect(parameters).toEqual({ searchTerm: '%Joao\\_\\%%' });
    });

    it('adds no search clause for a blank query', async () => {
      const profileQueryBuilder = makeQueryBuilderStub({
        getManyAndCount: [[], 0],
      });
      profiles.createQueryBuilder.mockReturnValue(profileQueryBuilder);

      await service.list({ q: '   ' });

      expect(profileQueryBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('defaults to page 1 and returns an empty envelope with no members', async () => {
      profiles.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getManyAndCount: [[], 0] }),
      );

      const result = await service.list({});

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: ADMIN_MEMBERS_PAGE_SIZE,
      });
      // No member rows means none of the per-page aggregate queries should
      // ever run.
      expect(vouchService.getVouchCounts).not.toHaveBeenCalled();
      expect(vouches.createQueryBuilder).not.toHaveBeenCalled();
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
      expect(communityMembers.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('listFlagged', () => {
    it('returns an empty list when nobody has an open report or is suspended', async () => {
      reports.find.mockResolvedValue([]);
      users.find.mockResolvedValue([]);

      await expect(service.listFlagged()).resolves.toEqual([]);
      // No candidate userId was ever discovered, so the profile lookup that
      // would build the flagged cards never needs to run.
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('flags a suspended member even with no open reports, as frozen', async () => {
      reports.find.mockResolvedValue([]);
      users.find.mockResolvedValue([{ id: 'user-suspended' }]);
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'user-suspended', slug: 'kai-devon' }),
      ]);

      const [flaggedMember] = await service.listFlagged();

      expect(flaggedMember!.slug).toBe('kai-devon');
      expect(flaggedMember!.openReportCount).toBe(0);
      // Suspended with no open reports left driving it reads as frozen, per
      // the documented heuristic in the service.
      expect(flaggedMember!.moderationState).toBe('frozen');
    });

    it("discovers a member by their reports' subjectId (slug), and surfaces the most frequent reason and latest detail", async () => {
      const flaggedProfile = makeProfile({
        userId: 'user-devon',
        slug: 'devon-rae',
      });
      // Newest first, mirroring the service's `order: { createdAt: 'DESC' }`.
      reports.find.mockResolvedValue([
        makeReport({
          id: 'report-new',
          subjectId: 'devon-rae',
          reasonCode: 'harassment',
          detail: 'Second complaint, same reason.',
          createdAt: daysAgo(1),
        }),
        makeReport({
          id: 'report-old',
          subjectId: 'devon-rae',
          reasonCode: 'harassment',
          detail: 'First complaint.',
          createdAt: daysAgo(5),
        }),
      ]);
      users.find.mockResolvedValue([]);
      profiles.find.mockResolvedValue([flaggedProfile]);

      const [flaggedMember] = await service.listFlagged();

      expect(flaggedMember!.slug).toBe('devon-rae');
      expect(flaggedMember!.openReportCount).toBe(2);
      expect(flaggedMember!.topReasonCode).toBe('harassment');
      expect(flaggedMember!.latestReportDetail).toBe(
        'Second complaint, same reason.',
      );
      // Neither suspended nor frozen — just under active review.
      expect(flaggedMember!.moderationState).toBe('under_review');
    });
  });

  describe('getMember', () => {
    it('404s on an unknown slug or id', async () => {
      profiles.findOne.mockResolvedValue(null);

      await expect(service.getMember('nobody')).rejects.toThrow(
        NotFoundException,
      );
      expect(profiles.findOne).toHaveBeenCalledWith({
        where: [{ slug: 'nobody' }],
      });
    });

    it('assembles the detail view for a known member', async () => {
      const profile = makeProfile();
      profiles.findOne.mockResolvedValue(profile);
      vouchService.getVouchCount.mockResolvedValue(5);
      vouches.find.mockResolvedValue([]);
      reports.find.mockResolvedValue([]);
      const membershipQueryBuilder = makeQueryBuilderStub({
        getRawMany: [{ role: RosterRole.Member, name: 'Circle of Care' }],
      });
      communityMembers.createQueryBuilder.mockReturnValue(
        membershipQueryBuilder,
      );

      const result = await service.getMember('ines-martins');

      expect(result.slug).toBe('ines-martins');
      expect(result.vouchCount).toBe(5);
      expect(result.communities).toEqual([
        { name: 'Circle of Care', role: 'member' },
      ]);
      // No open reports and a verified profile both synthesize a "good"
      // timeline entry.
      expect(
        result.moderationTimeline.some((entry) => entry.action === 'verified'),
      ).toBe(true);
      expect(
        result.moderationTimeline.some(
          (entry) => entry.action === 'no_reports',
        ),
      ).toBe(true);
    });

    it('excludes spaces (subcommunities) from the communities list', async () => {
      const profile = makeProfile();
      profiles.findOne.mockResolvedValue(profile);
      vouchService.getVouchCount.mockResolvedValue(0);
      vouches.find.mockResolvedValue([]);
      reports.find.mockResolvedValue([]);
      const membershipQueryBuilder = makeQueryBuilderStub({ getRawMany: [] });
      communityMembers.createQueryBuilder.mockReturnValue(
        membershipQueryBuilder,
      );

      await service.getMember('ines-martins');

      expect(membershipQueryBuilder.andWhere).toHaveBeenCalledWith(
        'community.parent_id IS NULL',
      );
    });
  });

  describe('listStaffRoster', () => {
    /** A roster user as the service reads it: the tier, the state, the join
     *  date and the profile relation. */
    function makeRosterUser(
      overrides: {
        id?: string;
        role?: UserRole;
        status?: UserStatus;
        profile?: Partial<Profile> | null;
      } = {},
    ): User {
      const userId = overrides.id ?? 'user-ines';
      return {
        id: userId,
        role: overrides.role ?? UserRole.Member,
        status: overrides.status ?? UserStatus.Active,
        isSystem: false,
        createdAt: daysAgo(300),
        profile:
          overrides.profile === null
            ? null
            : makeProfile({
                userId,
                photoVisible: true,
                ...overrides.profile,
              }),
      } as unknown as User;
    }

    function makeGrantRow(userId: string, role: string, grantedDaysAgo = 10) {
      return { userId, role, grantedAt: daysAgo(grantedDaysAgo) };
    }

    it('returns one row per person across tiers and grant holders, sorted admins, moderators, members, then by name', async () => {
      staffRoles.find.mockResolvedValue([
        makeGrantRow('user-admin', 'communities'),
        makeGrantRow('user-member-zoe', 'housing_moderator'),
        makeGrantRow('user-member-ana', 'magazine_writer'),
      ]);
      users.find
        .mockResolvedValueOnce([
          makeRosterUser({
            id: 'user-moderator',
            role: UserRole.Moderator,
            profile: { slug: 'mo-reyes', firstName: 'Mo', lastName: 'Reyes' },
          }),
          makeRosterUser({
            id: 'user-admin',
            role: UserRole.Admin,
            profile: { slug: 'sam-ortiz', firstName: 'Sam', lastName: 'Ortiz' },
          }),
        ])
        .mockResolvedValueOnce([
          makeRosterUser({
            id: 'user-member-zoe',
            profile: { slug: 'zoe-lima', firstName: 'Zoe', lastName: 'Lima' },
          }),
          makeRosterUser({
            id: 'user-member-ana',
            profile: { slug: 'ana-silva', firstName: 'Ana', lastName: 'Silva' },
          }),
        ]);

      const roster = await service.listStaffRoster();

      expect(roster.map((rosterRow) => rosterRow.slug)).toEqual([
        'sam-ortiz',
        'mo-reyes',
        'ana-silva',
        'zoe-lima',
      ]);
      // The admin holding a grant matches the tier read and the grant table,
      // and still appears once, carrying both.
      expect(roster[0]).toEqual({
        id: 'user-admin',
        slug: 'sam-ortiz',
        firstName: 'Sam',
        lastName: 'Ortiz',
        avatarUrl: null,
        platformRole: 'admin',
        status: 'active',
        joinedAt: daysAgo(300).toISOString(),
        grants: [{ role: 'communities', grantedAt: daysAgo(10).toISOString() }],
      });
      // An unbadged grant (`magazine_writer`) still earns a roster row.
      expect(roster[2]!.grants).toEqual([
        { role: 'magazine_writer', grantedAt: daysAgo(10).toISOString() },
      ]);
      expect(roster[1]!.grants).toEqual([]);
    });

    it('looks up only the grant holders the tier read did not already return, in one batched query', async () => {
      staffRoles.find.mockResolvedValue([
        makeGrantRow('user-admin', 'editorial'),
        makeGrantRow('user-member', 'resource_curator'),
      ]);
      users.find
        .mockResolvedValueOnce([
          makeRosterUser({ id: 'user-admin', role: UserRole.Admin }),
        ])
        .mockResolvedValueOnce([
          makeRosterUser({
            id: 'user-member',
            profile: { slug: 'river-day' },
          }),
        ]);

      await service.listStaffRoster();

      expect(users.find).toHaveBeenCalledTimes(2);
      expect(users.find).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { id: In(['user-member']), isSystem: false },
        }),
      );
    });

    it('skips the holder lookup entirely when every grant holder is already on a tier', async () => {
      staffRoles.find.mockResolvedValue([
        makeGrantRow('user-moderator', 'directory_moderator'),
      ]);
      users.find.mockResolvedValueOnce([
        makeRosterUser({ id: 'user-moderator', role: UserRole.Moderator }),
      ]);

      await service.listStaffRoster();

      expect(users.find).toHaveBeenCalledTimes(1);
    });

    it('caps each population, keeps every status, and excludes house accounts', async () => {
      await service.listStaffRoster();

      expect(staffRoles.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: DEFAULT_LIST_LIMIT }),
      );
      // The exact `where` (no `status` key): a suspended or deactivated person
      // still holding power must stay visible to the admin deciding what to
      // revoke.
      expect(users.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            role: In([UserRole.Moderator, UserRole.Admin]),
            isSystem: false,
          },
          take: DEFAULT_LIST_LIMIT,
        }),
      );
    });

    it('serves suspended and deactivated staff with their status', async () => {
      users.find.mockResolvedValueOnce([
        makeRosterUser({
          id: 'user-suspended',
          role: UserRole.Moderator,
          status: UserStatus.Suspended,
          profile: { slug: 'kai-devon', firstName: 'Kai' },
        }),
        makeRosterUser({
          id: 'user-paused',
          role: UserRole.Moderator,
          status: UserStatus.Deactivated,
          profile: { slug: 'lee-park', firstName: 'Lee' },
        }),
      ]);

      const roster = await service.listStaffRoster();

      expect(
        roster.map((rosterRow) => [rosterRow.slug, rosterRow.status]),
      ).toEqual([
        ['kai-devon', 'suspended'],
        ['lee-park', 'deactivated'],
      ]);
    });

    it('orders grants by the registry and drops role strings this build does not know', async () => {
      staffRoles.find.mockResolvedValue([
        makeGrantRow('user-member', 'partnerships', 1),
        makeGrantRow('user-member', 'retired_role', 2),
        makeGrantRow('user-member', 'magazine_editor', 3),
        makeGrantRow('user-member', 'housing_moderator', 4),
      ]);
      users.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeRosterUser({ id: 'user-member' })]);

      const [rosterRow] = await service.listStaffRoster();

      expect(rosterRow!.grants.map((grant) => grant.role)).toEqual([
        'magazine_editor',
        'housing_moderator',
        'partnerships',
      ]);
    });

    it('leaves off a member whose only grant rows are unknown role strings', async () => {
      staffRoles.find.mockResolvedValue([
        makeGrantRow('user-member', 'retired_role'),
      ]);
      users.find.mockResolvedValueOnce([]);

      await expect(service.listStaffRoster()).resolves.toEqual([]);
      expect(users.find).toHaveBeenCalledTimes(1);
    });

    it('hides the avatar of a member who turned their photo off, and serves it otherwise', async () => {
      users.find.mockResolvedValueOnce([
        makeRosterUser({
          id: 'user-visible',
          role: UserRole.Admin,
          profile: {
            slug: 'ana-visible',
            firstName: 'Ana',
            avatarUrl: 'https://lh3.googleusercontent.com/ana',
            photoVisible: true,
          },
        }),
        makeRosterUser({
          id: 'user-hidden',
          role: UserRole.Admin,
          profile: {
            slug: 'bea-hidden',
            firstName: 'Bea',
            avatarUrl: 'https://lh3.googleusercontent.com/bea',
            photoVisible: false,
          },
        }),
      ]);

      const roster = await service.listStaffRoster();

      expect(roster.map((rosterRow) => rosterRow.avatarUrl)).toEqual([
        'https://lh3.googleusercontent.com/ana',
        null,
      ]);
    });

    it('skips anyone without a profile row', async () => {
      users.find.mockResolvedValueOnce([
        makeRosterUser({
          id: 'user-no-profile',
          role: UserRole.Admin,
          profile: null,
        }),
        makeRosterUser({ id: 'user-admin', role: UserRole.Admin }),
      ]);

      const roster = await service.listStaffRoster();

      expect(roster.map((rosterRow) => rosterRow.id)).toEqual(['user-admin']);
    });
  });

  describe('grantStaffRole', () => {
    it("inserts a user_staff_roles row and writes a 'staff_role_granted' audit log", async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.findOne.mockResolvedValue(null); // not already held
      transactionStaffRoles.find.mockResolvedValue([
        { role: 'magazine_editor' },
      ]);

      const result = await service.grantStaffRole(
        'user-admin',
        'ines-martins',
        'magazine_editor',
      );

      expect(transactionStaffRoles.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-ines',
          role: 'magazine_editor',
          grantedById: 'user-admin',
        }),
      );
      expect(transactionAuditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: null,
          actorId: 'user-admin',
          action: 'staff_role_granted',
          note: 'magazine_editor',
        }),
      );
      expect(result).toEqual({
        userId: 'user-ines',
        slug: 'ines-martins',
        staffRoles: ['magazine_editor'],
      });
    });

    it('throws ForbiddenException for an isSystem house account, without writing anything', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: true,
      });

      await expect(
        service.grantStaffRole('user-admin', 'ines-martins', 'magazine_editor'),
      ).rejects.toThrow(ForbiddenException);
      expect(transactionStaffRoles.save).not.toHaveBeenCalled();
      expect(transactionAuditLogs.save).not.toHaveBeenCalled();
    });

    it('is idempotent — granting an already-held role writes no duplicate row and no second audit entry', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.findOne.mockResolvedValue({
        id: 'grant-1',
        userId: 'user-ines',
        role: 'magazine_editor',
      });
      transactionStaffRoles.find.mockResolvedValue([
        { role: 'magazine_editor' },
      ]);

      const result = await service.grantStaffRole(
        'user-admin',
        'ines-martins',
        'magazine_editor',
      );

      expect(transactionStaffRoles.save).not.toHaveBeenCalled();
      expect(transactionAuditLogs.save).not.toHaveBeenCalled();
      expect(result.staffRoles).toEqual(['magazine_editor']);
    });
  });

  describe('revokeStaffRole', () => {
    it("deletes the row and writes a 'staff_role_revoked' audit log", async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.delete.mockResolvedValue({ affected: 1 });
      transactionStaffRoles.find.mockResolvedValue([]);

      const result = await service.revokeStaffRole(
        'user-admin',
        'ines-martins',
        'magazine_editor',
      );

      expect(transactionStaffRoles.delete).toHaveBeenCalledWith({
        userId: 'user-ines',
        role: 'magazine_editor',
      });
      expect(transactionAuditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: null,
          actorId: 'user-admin',
          action: 'staff_role_revoked',
          note: 'magazine_editor',
        }),
      );
      expect(result).toEqual({
        userId: 'user-ines',
        slug: 'ines-martins',
        staffRoles: [],
      });
    });

    it('throws ForbiddenException for an isSystem house account, without deleting anything', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: true,
      });

      await expect(
        service.revokeStaffRole(
          'user-admin',
          'ines-martins',
          'magazine_editor',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(transactionStaffRoles.delete).not.toHaveBeenCalled();
      expect(transactionAuditLogs.save).not.toHaveBeenCalled();
    });

    it('is a no-op — no audit row — for a role the member does not hold', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.delete.mockResolvedValue({ affected: 0 });
      transactionStaffRoles.find.mockResolvedValue([]);

      const result = await service.revokeStaffRole(
        'user-admin',
        'ines-martins',
        'magazine_writer',
      );

      expect(transactionAuditLogs.save).not.toHaveBeenCalled();
      expect(result.staffRoles).toEqual([]);
    });

    it('releases the ambassadors circle staff seat when the partnerships grant goes (ENG-457)', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.delete.mockResolvedValue({ affected: 1 });

      await service.revokeStaffRole(
        'user-admin',
        'ines-martins',
        'partnerships',
        'Moved to the events desk',
      );

      expect(ambassadorsService.releaseStaffSeat).toHaveBeenCalledWith(
        'user-ines',
      );
    });

    it('runs the seat release again on a retried partnerships revoke, so a failed release heals', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.delete.mockResolvedValue({ affected: 0 });

      await service.revokeStaffRole(
        'user-admin',
        'ines-martins',
        'partnerships',
      );

      expect(ambassadorsService.releaseStaffSeat).toHaveBeenCalledWith(
        'user-ines',
      );
    });

    it('leaves the circle alone when another staff role is revoked', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        isSystem: false,
      });
      transactionStaffRoles.delete.mockResolvedValue({ affected: 1 });

      await service.revokeStaffRole(
        'user-admin',
        'ines-martins',
        'magazine_editor',
      );

      expect(ambassadorsService.releaseStaffSeat).not.toHaveBeenCalled();
    });
  });

  describe('updateRole', () => {
    it('releases the ambassadors circle staff seat when an admin is demoted (ENG-457)', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        role: UserRole.Admin,
        isSystem: false,
      });

      await service.updateRole('user-admin', 'ines-martins', UserRole.Member);

      expect(transactionUsers.update).toHaveBeenCalledWith(
        { id: 'user-ines' },
        { role: UserRole.Member },
      );
      expect(ambassadorsService.releaseStaffSeat).toHaveBeenCalledWith(
        'user-ines',
      );
    });

    it('keeps the seat of a member promoted to admin', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        role: UserRole.Member,
        isSystem: false,
      });

      await service.updateRole('user-admin', 'ines-martins', UserRole.Admin);

      expect(ambassadorsService.releaseStaffSeat).not.toHaveBeenCalled();
    });

    it('re-seats the QueerPulse Team mailbox when a role changes (PRD-372)', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        role: UserRole.Member,
        isSystem: false,
      });

      await service.updateRole(
        'user-admin',
        'ines-martins',
        UserRole.Moderator,
      );

      expect(officialMailboxSeats.resyncStaff).toHaveBeenCalledTimes(1);
    });

    it('leaves the QueerPulse Team mailbox alone for a no-op role change', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        role: UserRole.Moderator,
        isSystem: false,
      });

      await service.updateRole(
        'user-admin',
        'ines-martins',
        UserRole.Moderator,
      );

      expect(officialMailboxSeats.resyncStaff).not.toHaveBeenCalled();
    });

    it('keeps a committed role change when the mailbox resync fails', async () => {
      profiles.findOne.mockResolvedValue(makeProfile());
      transactionUsers.findOne.mockResolvedValue({
        id: 'user-ines',
        role: UserRole.Moderator,
        isSystem: false,
      });
      officialMailboxSeats.resyncStaff.mockRejectedValue(new Error('down'));

      await expect(
        service.updateRole('user-admin', 'ines-martins', UserRole.Member),
      ).resolves.toMatchObject({ role: UserRole.Member });
    });
  });
});
