import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PartnersService } from '../partners/partners.service';
import { Profile } from '../users/entities/profile.entity';
import { VolunteerOpportunityTeam } from './entities/volunteer-opportunity-team.entity';
import {
  OpportunityCause,
  OpportunityCommitLevel,
  OpportunityStatus,
  VolunteerOpportunity,
} from './entities/volunteer-opportunity.entity';
import { VolunteerSignup } from './entities/volunteer-signup.entity';
import { VolunteeringService } from './volunteering.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('VolunteeringService', () => {
  let service: VolunteeringService;
  let opportunities: {
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
  let signups: {
    count: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let partnersService: { idBySlug: jest.Mock; refsByIds: jest.Mock };
  let managerFindOne: jest.Mock;

  const baseDto = {
    org: 'Queer Youth Collective',
    role: 'Mentor',
    cause: OpportunityCause.Youth,
    commit: OpportunityCommitLevel.Low,
    time: '2 hrs / week',
    location: 'Lisbon',
    desc: 'Mentor queer youth.',
    spotsTotal: 3,
    applyRole: 'Volunteer Coordinator',
  };

  beforeEach(async () => {
    opportunities = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (the A4 lesson, mirrored from
      // `companies.service.spec.ts`/`jobs.service.spec.ts`).
      save: jest.fn((o: unknown) =>
        Promise.resolve({
          id: 'opp-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(o as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    team = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    signups = {
      count: jest.fn().mockResolvedValue(0),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'signup-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    // Default: an unknown/absent partnerSlug never resolves, and no
    // opportunity carries a partner link — every existing test (written
    // before Partners existed) keeps passing unmodified.
    partnersService = {
      idBySlug: jest.fn().mockResolvedValue(null),
      refsByIds: jest.fn().mockResolvedValue(new Map()),
    };
    managerFindOne = jest.fn();

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use, so assertions work whether the code
    // path runs inside the transaction or not — mirrors
    // `companies.service.spec.ts`. `manager.findOne` backs `signup()`'s
    // row-locked read, mirroring `rsvp.service.spec.ts`.
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === VolunteerOpportunity) return opportunities;
        if (entity === VolunteerOpportunityTeam) return team;
        if (entity === VolunteerSignup) return signups;
        if (entity === Profile) return profiles;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
      findOne: managerFindOne,
    };
    const dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VolunteeringService,
        {
          provide: getRepositoryToken(VolunteerOpportunity),
          useValue: opportunities,
        },
        {
          provide: getRepositoryToken(VolunteerOpportunityTeam),
          useValue: team,
        },
        { provide: getRepositoryToken(VolunteerSignup), useValue: signups },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: PartnersService, useValue: partnersService },
      ],
    }).compile();
    service = module.get(VolunteeringService);
  });

  describe('create', () => {
    it('stores partnerId: null when partnerSlug does not resolve to a known partner', async () => {
      const res = await service.create('poster-1', {
        ...baseDto,
        partnerSlug: 'some-partner',
      });

      expect(partnersService.idBySlug).toHaveBeenCalledWith('some-partner');
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: null, posterId: 'poster-1' }),
      );
      expect(res.partner).toBeNull();
      expect(res.isPoster).toBe(true);
    });

    it('resolves a known partnerSlug to partner_id via PartnersService', async () => {
      partnersService.idBySlug.mockResolvedValue('partner-1');

      await service.create('poster-1', {
        ...baseDto,
        partnerSlug: 'ilga-portugal',
      });

      expect(partnersService.idBySlug).toHaveBeenCalledWith('ilga-portugal');
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-1' }),
      );
    });

    it('resolves team slugs via MemberLookup and seeds volunteer_opportunity_team rows, deduping the poster', async () => {
      const qb = qbStub();
      qb.getMany = jest.fn().mockResolvedValue([
        { slug: 'jo', userId: 'teammate-1' },
        { slug: 'poster-slug', userId: 'poster-1' }, // resolves to the poster -> deduped
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.create('poster-1', {
        ...baseDto,
        team: ['jo', 'poster-slug'],
      });

      expect(team.save).toHaveBeenCalledWith([
        expect.objectContaining({
          opportunityId: 'opp-1',
          userId: 'teammate-1',
        }),
      ]);
    });
  });

  describe('getBySlug / spotsPct', () => {
    it('404s an unknown slug', async () => {
      opportunities.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope', 'u1')).rejects.toThrow(
        'Opportunity not found',
      );
    });

    it('derives spotsFilled/spotsPct from the signup count', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'mentor-qyc',
        org: 'Queer Youth Collective',
        partnerId: null,
        role: 'Mentor',
        cause: OpportunityCause.Youth,
        commit: OpportunityCommitLevel.Low,
        time: '2 hrs / week',
        location: 'Lisbon',
        skills: [],
        desc: 'Mentor queer youth.',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 4,
        applyRole: 'Volunteer Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      signups.count.mockResolvedValue(3);

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.spotsFilled).toBe(3);
      expect(detail.spotsPct).toBe(75); // round(3/4 * 100)
      expect(detail.isPoster).toBe(false);
    });

    it('guards divide-by-zero when spotsTotal is 0', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-2',
        slug: 'zero-spots',
        org: 'Org',
        partnerId: null,
        role: 'Role',
        cause: OpportunityCause.Arts,
        commit: OpportunityCommitLevel.Medium,
        time: '1 hr',
        location: 'Porto',
        skills: [],
        desc: 'desc',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 0,
        applyRole: 'Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      signups.count.mockResolvedValue(0);

      const detail = await service.getBySlug('zero-spots', 'viewer-1');

      expect(detail.spotsPct).toBe(0);
    });
  });

  describe('update', () => {
    it('rejects a non-poster', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(
        service.update('x', 'intruder', { role: 'Hijacked' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-resolves partnerId when partnerSlug is patched (unlike handle/team, this IS a legitimate PATCH field)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: null,
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      partnersService.idBySlug.mockResolvedValue('partner-2');

      await service.update('x', 'poster-1', { partnerSlug: 'a-partner' });

      expect(partnersService.idBySlug).toHaveBeenCalledWith('a-partner');
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-2' }),
      );
    });

    it('leaves the existing partner link untouched when partnerSlug is omitted', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: 'partner-1',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });

      await service.update('x', 'poster-1', { role: 'New role' });

      expect(partnersService.idBySlug).not.toHaveBeenCalled();
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-1' }),
      );
    });
  });

  describe('signup', () => {
    it('maps a full opportunity to 409 Conflict', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        spotsTotal: 2,
      });
      signups.count.mockResolvedValue(2); // already full

      await expect(service.signup('x', 'user-1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(signups.save).not.toHaveBeenCalled();
    });

    it('maps a duplicate (opportunity, user) signup to 409 Conflict', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(1);
      signups.save.mockRejectedValueOnce({ code: '23505' });

      await expect(service.signup('x', 'user-1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('creates a signup under capacity and resolves the member MemberRef', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(1);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.signup('x', 'user-1', { note: 'Excited!' });

      expect(res.member?.slug).toBe('jo');
      expect(res.note).toBe('Excited!');
    });
  });

  describe('withdraw', () => {
    it('deletes the viewer signup for the resolved opportunity', async () => {
      opportunities.findOne.mockResolvedValue({ id: 'opp-1', slug: 'x' });

      await service.withdraw('x', 'user-1');

      expect(signups.delete).toHaveBeenCalledWith({
        opportunityId: 'opp-1',
        userId: 'user-1',
      });
    });
  });

  describe('listSignups', () => {
    it('rejects a non-poster (403)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(service.listSignups('x', 'intruder')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lists signups for the poster', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.find.mockResolvedValue([
        {
          id: 'signup-1',
          opportunityId: 'opp-1',
          userId: 'user-1',
          note: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.listSignups('x', 'poster-1');

      expect(res).toHaveLength(1);
      expect(res[0].member?.slug).toBe('jo');
    });
  });
});
