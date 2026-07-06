import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JobsService } from '../jobs/jobs.service';
import { Profile } from '../users/entities/profile.entity';
import { CompaniesService } from './companies.service';
import { CompanyReview } from './entities/company-review.entity';
import { CompanyTeamMember } from './entities/company-team-member.entity';
import { Company } from './entities/company.entity';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `communities.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('CompaniesService', () => {
  let service: CompaniesService;
  let companies: {
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let team: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let reviews: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let jobsService: { listOpenForCompany: jest.Mock };

  beforeEach(async () => {
    companies = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      save: jest.fn((c: unknown) => Promise.resolve(c)),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    team = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    reviews = {
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns (`id`, `createdAt`) so a mapper reading
      // them off a `save()` result never sees `undefined` (the A4 lesson:
      // a bare-passthrough mock caused an `undefined.toISOString()` throw).
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'review-id',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    // `getOpenRoles` now delegates to `JobsService.listOpenForCompany` (the
    // Jobs wiring) — every test in this file exercises companies in
    // isolation, so this always resolves empty unless a test says otherwise.
    jobsService = {
      listOpenForCompany: jest.fn().mockResolvedValue([]),
    };

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use, so assertions work whether the code
    // path runs inside the transaction or not — mirrors
    // `communities.service.spec.ts`.
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Company) return companies;
        if (entity === CompanyTeamMember) return team;
        if (entity === Profile) return profiles;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: getRepositoryToken(Company), useValue: companies },
        { provide: getRepositoryToken(CompanyTeamMember), useValue: team },
        { provide: getRepositoryToken(CompanyReview), useValue: reviews },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: JobsService, useValue: jobsService },
      ],
    }).compile();
    service = module.get(CompaniesService);
  });

  describe('create', () => {
    const baseDto = {
      nameText: 'Atelier Pulso',
      tagline: 'Design studio',
      about: 'We make things.',
      handle: 'atelier-pulso',
    };

    it('forces verified=false regardless of input, and sets ownerId/slug', async () => {
      companies.save.mockImplementation((c: Partial<Company>) => ({
        ...c,
        id: 'co-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));

      const res = await service.create('owner-1', {
        ...baseDto,
        // even if a caller somehow slipped this through, it's not read
      });

      expect(res.slug).toBe('atelier-pulso');
      expect(res.badges.verified).toBe(false);
      expect(companies.save).toHaveBeenCalledWith(
        expect.objectContaining({ verified: false, ownerId: 'owner-1' }),
      );
      expect(res.isOwner).toBe(true);
    });

    it('resolves team slugs via MemberLookup and seeds company_team_members rows, deduping the owner', async () => {
      companies.save.mockImplementation((c: Partial<Company>) => ({
        ...c,
        id: 'co-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      const qb = qbStub();
      qb.getMany.mockResolvedValue([
        { slug: 'jo', userId: 'teammate-1' },
        { slug: 'owner-slug', userId: 'owner-1' }, // resolves to the owner -> deduped
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.create('owner-1', {
        ...baseDto,
        team: ['jo', 'owner-slug'],
      });

      expect(team.save).toHaveBeenCalledWith([
        expect.objectContaining({ companyId: 'co-1', userId: 'teammate-1' }),
      ]);
      expect(companies.save).toHaveBeenCalledWith(
        expect.objectContaining({ teamCount: 1 }),
      );
    });
  });

  describe('getBySlug / review aggregates', () => {
    it('404s an unknown slug', async () => {
      companies.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('computes avg/count/bars correctly from raw review stars', async () => {
      companies.findOne.mockResolvedValue({
        id: 'co-1',
        slug: 'atelier-pulso',
        nameText: 'Atelier Pulso',
        tagline: 't',
        about: 'a',
        queerRun: true,
        queerLed: true,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work: [],
        ownerId: 'owner-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([
        { companyId: 'co-1', stars: 5 },
        { companyId: 'co-1', stars: 5 },
        { companyId: 'co-1', stars: 3 },
        { companyId: 'co-1', stars: 1 },
      ]);
      reviews.createQueryBuilder.mockReturnValue(qb);

      const detail = await service.getBySlug('atelier-pulso', 'owner-1');

      expect(detail.reviewCount).toBe(4);
      expect(detail.reviewScore).toBeCloseTo((5 + 5 + 3 + 1) / 4);
      expect(detail.reviewBars).toEqual({
        one: 1,
        two: 0,
        three: 1,
        four: 0,
        five: 2,
      });
      expect(detail.isOwner).toBe(true);
      expect(detail.openRoles).toEqual([]);
      expect(detail.openRolesCount).toBe(0);
    });

    it('reports reviewScore=null with zero-filled bars when there are no reviews', async () => {
      companies.findOne.mockResolvedValue({
        id: 'co-2',
        slug: 'no-reviews',
        nameText: 'No Reviews Co',
        tagline: 't',
        about: 'a',
        queerRun: false,
        queerLed: false,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work: [],
        ownerId: 'owner-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const detail = await service.getBySlug('no-reviews', 'someone-else');

      expect(detail.reviewScore).toBeNull();
      expect(detail.reviewCount).toBe(0);
      expect(detail.isOwner).toBe(false);
    });
  });

  describe('update', () => {
    it('rejects a non-owner', async () => {
      companies.findOne.mockResolvedValue({
        id: 'co-1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      await expect(
        service.update('x', 'intruder', { tagline: 'hijacked' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists a partial update for the owner', async () => {
      const company = {
        id: 'co-1',
        slug: 'x',
        nameText: 'Old Name',
        tagline: 'Old tagline',
        about: 'about',
        queerRun: false,
        queerLed: false,
        verified: false,
        values: [],
        info: [],
        teamCount: 0,
        hiringContact: null,
        work: [],
        ownerId: 'owner-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      companies.findOne.mockResolvedValue(company);

      const res = await service.update('x', 'owner-1', {
        tagline: 'New tagline',
      });

      expect(res.tagline).toBe('New tagline');
      expect(companies.save).toHaveBeenCalledWith(
        expect.objectContaining({ tagline: 'New tagline' }),
      );
    });
  });

  describe('createReview', () => {
    it('maps a duplicate (company, author) review to 409 Conflict', async () => {
      companies.findOne.mockResolvedValue({ id: 'co-1', slug: 'x' });
      reviews.save.mockRejectedValueOnce({ code: '23505' });

      await expect(
        service.createReview('x', 'author-1', {
          title: 'Great place',
          stars: 5,
          byline: 'Former employee',
          body: ['Loved it'],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a review and resolves the author MemberRef', async () => {
      companies.findOne.mockResolvedValue({ id: 'co-1', slug: 'x' });
      profiles.find.mockResolvedValue([
        {
          userId: 'author-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.createReview('x', 'author-1', {
        title: 'Great place',
        stars: 5,
        byline: 'Former employee',
        body: ['Loved it'],
      });

      expect(res.stars).toBe(5);
      expect(res.author?.slug).toBe('jo');
    });
  });
});
