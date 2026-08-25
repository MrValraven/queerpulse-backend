import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import {
  Changemaker,
  ChangemakerStatus,
} from '../changemakers/entities/changemaker.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import {
  LandingFeature,
  LandingSection,
} from './entities/landing-feature.entity';
import { LandingService } from './landing.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default — mirrors `companies.service.spec.ts`'s `qbStub`.
function qbStub() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'take',
    'setLock',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  return qb;
}

function makeProfile(overrides: Partial<Profile>): Profile {
  return {
    userId: 'profile-id',
    slug: 'someone',
    firstName: 'Some',
    lastName: 'One',
    tagline: null,
    avatarUrl: null,
    visibility: ProfileVisibility.Open,
    featuredConsent: true,
    ...overrides,
  } as Profile;
}

function makeCommunity(overrides: Partial<Community>): Community {
  return {
    id: 'community-id',
    slug: 'some-community',
    name: 'Some Community',
    accessTier: AccessTier.Public,
    archivedAt: null,
    frozenAt: null,
    // The card renders a category badge, a "since ‹year›" line and the
    // "what you get" chips, so a fixture missing these blows up in the mapper
    // rather than in the assertion.
    type: CommunityType.Social,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    features: [],
    coverImageUrl: null,
    rosterVisible: true,
    ...overrides,
  } as Community;
}

function makeChangemaker(overrides: Partial<Changemaker>): Changemaker {
  return {
    id: 'changemaker-id',
    slug: 'some-changemaker',
    name: 'Some Changemaker',
    status: ChangemakerStatus.Published,
    imageUrl: null,
    ...overrides,
  } as Changemaker;
}

function makeFeature(overrides: Partial<LandingFeature>): LandingFeature {
  return {
    id: 'feature-id',
    section: LandingSection.Member,
    targetId: 'target-id',
    position: 0,
    copy: { quote: 'A real quote' },
    active: true,
    createdBy: 'admin-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('LandingService', () => {
  let service: LandingService;
  let landingFeatures: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communities: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let changemakers: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communityMembers: { createQueryBuilder: jest.Mock };
  // The transactional `EntityManager` seen inside `dataSource.transaction`'s
  // callback — `createFeature` and `reorderFeatures` both now do their
  // section-row-locking + writes through this, not through the outer
  // `landingFeatures` repo mock.
  let manager: {
    createQueryBuilder: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    landingFeatures = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      // Pass-through, like `companies.service.spec.ts`'s repo mocks — the
      // entity is whatever fields were given.
      create: jest.fn((value: object) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    communities = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    changemakers = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    communityMembers = { createQueryBuilder: jest.fn(() => qbStub()) };
    manager = {
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (manager: unknown) => Promise<unknown>) =>
          callback(manager),
      ),
      // The community roster strip picks its faces with one window-function
      // query rather than a per-community fetch. Default: no faces.
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LandingService,
        {
          provide: getRepositoryToken(LandingFeature),
          useValue: landingFeatures,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Changemaker), useValue: changemakers },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(LandingService);
  });

  describe('getPublicFeatures', () => {
    it('drops a featured member whose profile is Network (not Open)', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [
            makeFeature({ id: 'f-open', targetId: 'p-open', position: 0 }),
            makeFeature({
              id: 'f-network',
              targetId: 'p-network',
              position: 1,
            }),
          ];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'p-open', slug: 'open-member' }),
        makeProfile({
          userId: 'p-network',
          slug: 'network-member',
          visibility: ProfileVisibility.Network,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members.map((member) => member.slug)).toEqual([
        'open-member',
      ]);
    });

    it('drops a featured member who revoked featuredConsent', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [makeFeature({ id: 'f-1', targetId: 'p-1', position: 0 })];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'p-1',
          slug: 'no-consent',
          featuredConsent: false,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members).toEqual([]);
    });

    it('drops a community that is not AccessTier.Public', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-public',
              section: LandingSection.Community,
              targetId: 'c-public',
              position: 0,
              copy: { blurb: 'welcoming' },
            }),
            makeFeature({
              id: 'f-request',
              section: LandingSection.Community,
              targetId: 'c-request',
              position: 1,
              copy: { blurb: 'request only' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-public', slug: 'public-community' }),
        makeCommunity({
          id: 'c-request',
          slug: 'request-community',
          accessTier: AccessTier.Request,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.communities.map((community) => community.slug)).toEqual([
        'public-community',
      ]);
    });

    it('drops a changemaker that is not Published', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Changemaker) return [];
          return [
            makeFeature({
              id: 'f-published',
              section: LandingSection.Changemaker,
              targetId: 'cm-published',
              position: 0,
              copy: { cause: 'Housing', blurb: 'Fights for housing.' },
            }),
            makeFeature({
              id: 'f-draft',
              section: LandingSection.Changemaker,
              targetId: 'cm-draft',
              position: 1,
              copy: { cause: 'Health', blurb: 'Fights for health.' },
            }),
          ];
        },
      );
      changemakers.find.mockResolvedValue([
        makeChangemaker({ id: 'cm-published', slug: 'published-changemaker' }),
        makeChangemaker({
          id: 'cm-draft',
          slug: 'draft-changemaker',
          status: ChangemakerStatus.Draft,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(
        result.changemakers.map((changemaker) => changemaker.slug),
      ).toEqual(['published-changemaker']);
    });

    it('orders survivors by position ascending within each section', async () => {
      // Simulates what `IDX_landing_feature_section_active_position` already
      // guarantees at the DB layer (`ORDER BY position ASC`) — the service
      // must preserve that order through filtering, never re-sort or shuffle.
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [
            makeFeature({ id: 'f-a', targetId: 'p-a', position: 0 }),
            makeFeature({ id: 'f-b', targetId: 'p-b', position: 1 }),
            makeFeature({ id: 'f-c', targetId: 'p-c', position: 2 }),
          ];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'p-a', slug: 'member-a' }),
        makeProfile({ userId: 'p-b', slug: 'member-b' }),
        makeProfile({ userId: 'p-c', slug: 'member-c' }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members.map((member) => member.slug)).toEqual([
        'member-a',
        'member-b',
        'member-c',
      ]);
    });
  });

  describe('createFeature', () => {
    it('rejects an ineligible member target with BadRequestException', async () => {
      profiles.findOne.mockResolvedValue(
        makeProfile({ userId: 'p-1', visibility: ProfileVisibility.Network }),
      );

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Member,
          targetId: 'p-1',
          copy: { quote: 'Hello' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Ineligibility is caught before the position-assigning transaction is
      // ever opened.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a duplicate (section, target) as a ConflictException', async () => {
      profiles.findOne.mockResolvedValue(makeProfile({ userId: 'p-1' }));
      const uniqueViolation = Object.assign(new Error('duplicate key'), {
        driverError: {
          code: '23505',
          constraint: 'UQ_landing_feature_section_target',
        },
      });
      manager.save.mockRejectedValue(uniqueViolation);

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Member,
          targetId: 'p-1',
          copy: { quote: 'Hello' },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('assigns position = current max + 1 within the section', async () => {
      profiles.findOne.mockResolvedValue(makeProfile({ userId: 'p-1' }));
      // The transactional manager issues two `createQueryBuilder` calls — the
      // section-row lock (`getMany`, irrelevant here, defaults to `[]`) and
      // the `MAX(position)` read — both served by fresh stubs off the same
      // implementation, so both see the same `maxPosition`.
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getRawOne!.mockResolvedValue({ maxPosition: '3' });
        return qb;
      });

      const created = await service.createFeature('admin-1', {
        section: LandingSection.Member,
        targetId: 'p-1',
        copy: { quote: 'Hello' },
      });

      expect(created.position).toBe(4);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ position: 4 }),
      );
    });
  });

  describe('reorderFeatures', () => {
    it('rewrites positions to contiguous 0..n-1 in the given id order', async () => {
      const featuresStore: LandingFeature[] = [
        makeFeature({
          id: 'f-a',
          section: LandingSection.Community,
          targetId: 'c-a',
          position: 5,
        }),
        makeFeature({
          id: 'f-b',
          section: LandingSection.Community,
          targetId: 'c-b',
          position: 6,
        }),
        makeFeature({
          id: 'f-c',
          section: LandingSection.Community,
          targetId: 'c-c',
          position: 7,
        }),
      ];
      // `listAdminFeatures` re-reads the section via the outer `landingFeatures`
      // repo AFTER the transaction commits — kept in sync with the same
      // `featuresStore` the transactional lock/update below mutate.
      landingFeatures.find.mockImplementation(
        ({
          where,
          order,
        }: {
          where: { section: LandingSection };
          order?: { position: 'ASC' };
        }) => {
          const rows = featuresStore.filter(
            (feature) => feature.section === where.section,
          );
          return order?.position === 'ASC'
            ? [...rows].sort((a, b) => a.position - b.position)
            : rows;
        },
      );
      // The in-transaction lock+validate read (`manager.createQueryBuilder(...)
      // .getMany()`) reads from the same store.
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getMany = jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              featuresStore.filter(
                (feature) => feature.section === LandingSection.Community,
              ),
            ),
          );
        return qb;
      });
      const updateSpy = jest.fn(
        (
          _entity: unknown,
          criteria: { id: string },
          partial: Partial<LandingFeature>,
        ) => {
          const row = featuresStore.find(
            (feature) => feature.id === criteria.id,
          );
          if (row) Object.assign(row, partial);
        },
      );
      manager.update = updateSpy;
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-a', slug: 'community-a' }),
        makeCommunity({ id: 'c-b', slug: 'community-b' }),
        makeCommunity({ id: 'c-c', slug: 'community-c' }),
      ]);

      const result = await service.reorderFeatures({
        section: LandingSection.Community,
        orderedIds: ['f-c', 'f-a', 'f-b'],
      });

      expect(updateSpy).toHaveBeenCalledTimes(3);
      expect(result.map((feature) => feature.id)).toEqual([
        'f-c',
        'f-a',
        'f-b',
      ]);
      expect(result.map((feature) => feature.position)).toEqual([0, 1, 2]);
    });

    it("rejects when orderedIds does not match the section's current feature ids", async () => {
      // Validation now happens INSIDE the transaction (under the row lock),
      // so the read it validates against comes from `manager`, not the outer
      // `landingFeatures` repo.
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getMany = jest
          .fn()
          .mockResolvedValue([
            makeFeature({ id: 'f-a', section: LandingSection.Community }),
            makeFeature({ id: 'f-b', section: LandingSection.Community }),
          ]);
        return qb;
      });

      await expect(
        service.reorderFeatures({
          section: LandingSection.Community,
          orderedIds: ['f-a'], // missing f-b
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The transaction DOES open (the lock+validate read happens inside it),
      // it just never reaches the position-rewrite loop.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
