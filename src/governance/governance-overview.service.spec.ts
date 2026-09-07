import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GovernanceOverviewService } from './governance-overview.service';
import {
  GOVERNANCE_OVERVIEW_ID,
  GovernanceOverview,
} from './entities/governance-overview.entity';
import { governanceOverviewSeed } from './governance-overview.seed';
import { Profile } from '../users/entities/profile.entity';
import { PlatformStaffService } from '../platform-staff/platform-staff.service';
import { UsersService } from '../users/users.service';
import { DataSource } from 'typeorm';
import {
  GovernanceOverviewChange,
  OverviewSection,
} from './entities/governance-overview-change.entity';

function makeOverview(
  overrides: Partial<GovernanceOverview> = {},
): GovernanceOverview {
  return {
    id: GOVERNANCE_OVERVIEW_ID,
    health: governanceOverviewSeed.health,
    moderationSteps: governanceOverviewSeed.moderationSteps,
    council: governanceOverviewSeed.council,
    principles: governanceOverviewSeed.principles,
    decisions: governanceOverviewSeed.decisions,
    publishedAt: null,
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

// `activeMembers` is the one health stat NOT served from the stored row: the
// service overwrites it with a live count so the page can never quote a number
// that went stale between publishes.
const ACTIVE_MEMBER_COUNT = 412;
const seedHealthWithLiveCount = () =>
  governanceOverviewSeed.health.map((stat) =>
    stat.key === 'activeMembers'
      ? { ...stat, n: String(ACTIVE_MEMBER_COUNT) }
      : stat,
  );

describe('GovernanceOverviewService', () => {
  let service: GovernanceOverviewService;
  let usersService: { countActiveMembers: jest.Mock };
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let changesRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  // `getAdminOverview` now resolves the latest change per section with one
  // `DISTINCT ON (section)` query instead of scanning the whole history in JS
  // (BE-COM-36), so it goes through the query builder rather than `find`.
  let latestChangesQb: {
    distinctOn: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
  };
  let profilesRepo: { find: jest.Mock };
  let platformStaff: { listStaffUserIds: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    usersService = {
      countActiveMembers: jest.fn().mockResolvedValue(ACTIVE_MEMBER_COUNT),
    };
    repo = { findOne: jest.fn(), save: jest.fn() };
    latestChangesQb = {
      distinctOn: jest.fn(() => latestChangesQb),
      orderBy: jest.fn(() => latestChangesQb),
      addOrderBy: jest.fn(() => latestChangesQb),
      getMany: jest.fn().mockResolvedValue([]),
    };
    changesRepo = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => latestChangesQb),
    };
    profilesRepo = { find: jest.fn() };
    platformStaff = {
      listStaffUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // Every `updateOverview` test below asserts on what the service does
    // BEFORE the transaction opens, so the transaction body is never run.
    dataSource = { transaction: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceOverviewService,
        { provide: getRepositoryToken(GovernanceOverview), useValue: repo },
        {
          provide: getRepositoryToken(GovernanceOverviewChange),
          useValue: changesRepo,
        },
        { provide: getRepositoryToken(Profile), useValue: profilesRepo },
        { provide: UsersService, useValue: usersService },
        { provide: PlatformStaffService, useValue: platformStaff },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(GovernanceOverviewService);
  });

  function makeChange(
    overrides: Partial<GovernanceOverviewChange> = {},
  ): GovernanceOverviewChange {
    return {
      id: 'c1',
      section: OverviewSection.Council,
      actorId: 'user-1',
      before: governanceOverviewSeed.council,
      after: governanceOverviewSeed.council,
      note: null,
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
      ...overrides,
    };
  }

  describe('getOverview', () => {
    it('fetches the singleton row by its fixed id and maps it to the DTO', async () => {
      repo.findOne.mockResolvedValue(makeOverview());

      const result = await service.getOverview();

      // The singleton lookup must carry a `where` (keyed on the fixed id) — a
      // bare `findOne` throws "you must provide selection conditions".
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: GOVERNANCE_OVERVIEW_ID },
      });
      expect(result).toEqual({
        health: seedHealthWithLiveCount(),
        moderationSteps: governanceOverviewSeed.moderationSteps,
        council: governanceOverviewSeed.council,
        principles: governanceOverviewSeed.principles,
        decisions: governanceOverviewSeed.decisions,
        publishedAt: null,
      });
    });

    it('serves a LIVE activeMembers count, not the stored one', async () => {
      repo.findOne.mockResolvedValue(makeOverview());
      usersService.countActiveMembers.mockResolvedValue(9001);

      const result = await service.getOverview();

      expect(
        result.health.find((stat) => stat.key === 'activeMembers')?.n,
      ).toBe('9001');
      // Every other stat still comes from the stored snapshot.
      expect(
        result.health.filter((stat) => stat.key !== 'activeMembers'),
      ).toEqual(
        governanceOverviewSeed.health.filter(
          (stat) => stat.key !== 'activeMembers',
        ),
      );
    });

    it('maps a published snapshot to an ISO `publishedAt`', async () => {
      const publishedAt = new Date('2026-08-05T10:00:00.000Z');
      repo.findOne.mockResolvedValue(makeOverview({ publishedAt }));

      const result = await service.getOverview();

      expect(result.publishedAt).toBe(publishedAt.toISOString());
    });

    it('404s when the overview has not been seeded', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getOverview()).rejects.toThrow(NotFoundException);
    });
  });

  describe('publish', () => {
    it('stamps `publishedAt` on the singleton and returns the ISO timestamp', async () => {
      const overview = makeOverview();
      repo.findOne.mockResolvedValue(overview);
      repo.save.mockImplementation((row: GovernanceOverview) =>
        Promise.resolve(row),
      );

      const before = Date.now();
      const result = await service.publish();
      const after = Date.now();

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: GOVERNANCE_OVERVIEW_ID },
      });
      expect(repo.save).toHaveBeenCalledWith(overview);
      expect(overview.publishedAt).toBeInstanceOf(Date);
      const stamped = new Date(result.publishedAt).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });

    it('404s when the overview has not been seeded', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.publish()).rejects.toThrow(NotFoundException);
    });
  });

  describe('getAdminOverview', () => {
    it('returns null editor/editedAt for every section when nothing has been edited', async () => {
      repo.findOne.mockResolvedValue(makeOverview());
      latestChangesQb.getMany.mockResolvedValue([]);

      const result = await service.getAdminOverview();

      expect(result.meta.council).toEqual({ editor: null, editedAt: null });
      expect(result.meta.health).toEqual({ editor: null, editedAt: null });
    });

    it('surfaces the most recent change per section, resolved to a display ref', async () => {
      repo.findOne.mockResolvedValue(makeOverview());
      // One row per section — `DISTINCT ON (section) ... ORDER BY section,
      // created_at DESC, id DESC` is what narrows the history down, so the
      // query already hands back only the newest row for each.
      latestChangesQb.getMany.mockResolvedValue([
        makeChange({
          id: 'newest',
          createdAt: new Date('2026-08-15T00:00:00.000Z'),
        }),
      ]);
      profilesRepo.find.mockResolvedValue([
        {
          userId: 'user-1',
          firstName: 'Ana',
          lastName: 'Costa',
          slug: 'ana',
          avatarUrl: null,
          pronouns: null,
        },
      ]);

      const result = await service.getAdminOverview();

      expect(result.meta.council.editedAt).toBe('2026-08-15T00:00:00.000Z');
      expect(result.meta.council.editor?.firstName).toBe('Ana');
      // Sections with no change rows stay untouched.
      expect(result.meta.decisions).toEqual({ editor: null, editedAt: null });
    });

    it('404s when the overview has not been seeded', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getAdminOverview()).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  // ── Advisory-council seats ────────────────────────────────────────────────
  // A seat stores a `memberId` and nothing else about the person, so both
  // reads resolve it and the write refuses anyone who is not staff.
  describe('advisory-council seats', () => {
    const CHAIR_ID = '11111111-1111-4111-8111-111111111111';
    const GONE_ID = '22222222-2222-4222-8222-222222222222';

    const seat = (memberId: string) => ({
      memberId,
      roleKey: 'psychologistChair' as const,
      tint: 'jade' as const,
    });

    const chairProfile = {
      userId: CHAIR_ID,
      firstName: 'Mariana',
      lastName: 'Loução',
      slug: 'mariana',
      avatarUrl: 'avatars/mariana.jpg',
      photoVisible: true,
      pronouns: 'ela/dela',
    };

    it('resolves a seat to the member behind it on the public read', async () => {
      repo.findOne.mockResolvedValue(
        makeOverview({ council: [seat(CHAIR_ID)] }),
      );
      profilesRepo.find.mockResolvedValue([chairProfile]);

      const result = await service.getOverview();

      expect(result.council).toHaveLength(1);
      expect(result.council[0]!.member.firstName).toBe('Mariana');
      expect(result.council[0]!.member.slug).toBe('mariana');
      expect(result.council[0]!.roleKey).toBe('psychologistChair');
      // The public page gets the person, never the platform's id for them.
      expect(result.council[0]!).not.toHaveProperty('memberId');
    });

    it('honours the member photo gate rather than reaching for avatarUrl', async () => {
      repo.findOne.mockResolvedValue(
        makeOverview({ council: [seat(CHAIR_ID)] }),
      );
      profilesRepo.find.mockResolvedValue([
        { ...chairProfile, photoVisible: false },
      ]);

      const result = await service.getOverview();

      // A seat-holder who has hidden their face keeps it hidden here; the
      // frontend falls back to the tinted monogram.
      expect(result.council[0]!.member.avatarUrl).toBeNull();
    });

    it('drops a seat whose member no longer resolves from the public read', async () => {
      repo.findOne.mockResolvedValue(
        makeOverview({ council: [seat(CHAIR_ID), seat(GONE_ID)] }),
      );
      profilesRepo.find.mockResolvedValue([chairProfile]);

      const result = await service.getOverview();

      // Rather than a seat with a hole where a person was.
      expect(result.council).toHaveLength(1);
      expect(result.council[0]!.member.slug).toBe('mariana');
    });

    it('KEEPS an unresolvable seat on the admin read, so someone can fix it', async () => {
      repo.findOne.mockResolvedValue(
        makeOverview({ council: [seat(CHAIR_ID), seat(GONE_ID)] }),
      );
      latestChangesQb.getMany.mockResolvedValue([]);
      profilesRepo.find.mockResolvedValue([chairProfile]);

      const result = await service.getAdminOverview();

      expect(result.council).toHaveLength(2);
      expect(result.council[1]!.memberId).toBe(GONE_ID);
      expect(result.council[1]!.member).toBeNull();
    });

    it('refuses a seat naming someone who is not on the staff roster', async () => {
      platformStaff.listStaffUserIds.mockResolvedValue(new Set([CHAIR_ID]));

      await expect(
        service.updateOverview({ council: [seat(GONE_ID)] }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      // Rejected before anything is written.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('names the offending seat by position, the only handle the editor has', async () => {
      platformStaff.listStaffUserIds.mockResolvedValue(new Set([CHAIR_ID]));

      await expect(
        service.updateOverview(
          { council: [seat(CHAIR_ID), seat(GONE_ID)] },
          'admin-1',
        ),
      ).rejects.toThrow(/Seat 2/);
    });

    it('refuses to seat one person twice', async () => {
      platformStaff.listStaffUserIds.mockResolvedValue(new Set([CHAIR_ID]));

      await expect(
        service.updateOverview(
          { council: [seat(CHAIR_ID), seat(CHAIR_ID)] },
          'admin-1',
        ),
      ).rejects.toThrow(/already holds a seat/);
    });

    it('accepts a council of staff members', async () => {
      platformStaff.listStaffUserIds.mockResolvedValue(new Set([CHAIR_ID]));
      repo.findOne.mockResolvedValue(
        makeOverview({ council: [seat(CHAIR_ID)] }),
      );
      latestChangesQb.getMany.mockResolvedValue([]);
      profilesRepo.find.mockResolvedValue([chairProfile]);

      await service.updateOverview({ council: [seat(CHAIR_ID)] }, 'admin-1');

      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('does not ask the roster at all when the payload leaves council alone', async () => {
      repo.findOne.mockResolvedValue(makeOverview());
      latestChangesQb.getMany.mockResolvedValue([]);

      await service.updateOverview({ note: 'typo fix' }, 'admin-1');

      expect(platformStaff.listStaffUserIds).not.toHaveBeenCalled();
    });
  });
});
