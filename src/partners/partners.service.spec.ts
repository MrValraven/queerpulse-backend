import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import {
  Partner,
  PartnerRegion,
  PartnerStatus,
} from './entities/partner.entity';
import { PartnersService } from './partners.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('PartnersService', () => {
  let service: PartnersService;
  let partners: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    find: jest.Mock;
  };

  const baseDto = {
    name: 'ILGA Portugal',
    logo: 'IP',
    region: PartnerRegion.Pt,
    regionLabel: 'Portugal',
    city: 'Lisbon',
    desc: 'Advocacy and support for LGBTI+ rights.',
    tier: 'Founding partner',
    since: '2019',
    eyebrow: 'Rights & advocacy',
    tagline: 'Rights, not favors.',
  };

  beforeEach(async () => {
    partners = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (the A4 lesson, mirrored from
      // `companies.service.spec.ts`/`volunteering.service.spec.ts`).
      save: jest.fn((p: unknown) =>
        Promise.resolve({
          id: 'partner-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(p as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnersService,
        { provide: getRepositoryToken(Partner), useValue: partners },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(PartnersService);
  });

  describe('list', () => {
    it('filters to approved partners only', async () => {
      await service.list({});

      const qb = partners.createQueryBuilder.mock.results[0].value as {
        where: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('p.status = :status', {
        status: PartnerStatus.Approved,
      });
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('adds a region filter when provided', async () => {
      await service.list({ region: PartnerRegion.Eu });

      const qb = partners.createQueryBuilder.mock.results[0].value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('p.region = :region', {
        region: PartnerRegion.Eu,
      });
    });
  });

  describe('getBySlug', () => {
    it('404s an unknown slug', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s a pending partner (hides existence from the public)', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        slug: 'ilga-portugal',
        status: PartnerStatus.Pending,
      });
      await expect(service.getBySlug('ilga-portugal')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns an approved partner', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        slug: 'ilga-portugal',
        name: 'ILGA Portugal',
        logo: 'IP',
        region: PartnerRegion.Pt,
        regionLabel: 'Portugal',
        city: 'Lisbon',
        desc: 'Advocacy and support.',
        tags: [],
        tier: 'Founding partner',
        since: '2019',
        eyebrow: 'Rights & advocacy',
        tagline: 'Rights, not favors.',
        about: [],
        stats: [],
        aboutMore: [],
        jointWork: [],
        timeline: [],
        how: [],
        funding: '',
        atGlance: [],
        contact: {
          phone: null,
          phoneNote: null,
          email: null,
          website: null,
          address: null,
        },
        status: PartnerStatus.Approved,
        submittedById: 'submitter-1',
        reviewNote: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const detail = await service.getBySlug('ilga-portugal');
      expect(detail.slug).toBe('ilga-portugal');
      expect(detail.name).toBe('ILGA Portugal');
    });
  });

  describe('submitApplication', () => {
    it('creates a pending application with the submitter set', async () => {
      const res = await service.submitApplication('member-1', {
        ...baseDto,
        handle: 'ilga-portugal',
      });

      expect(res.slug).toBe('ilga-portugal');
      expect(res.status).toBe('pending');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PartnerStatus.Pending,
          submittedById: 'member-1',
        }),
      );
    });

    it('normalizes contact subfields to null when omitted', async () => {
      await service.submitApplication('member-1', {
        ...baseDto,
        handle: 'ilga-portugal',
        contact: { email: 'geral@ilga-portugal.pt' },
      });

      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          contact: {
            phone: null,
            phoneNote: null,
            email: 'geral@ilga-portugal.pt',
            website: null,
            address: null,
          },
        }),
      );
    });
  });

  describe('listApplications', () => {
    it('lists only pending applications', async () => {
      await service.listApplications();
      expect(partners.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: PartnerStatus.Pending },
        }),
      );
    });
  });

  describe('triage', () => {
    it('404s an unknown id', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(service.triage('nope', 'approve')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('flips status to approved without touching reviewNote', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
        submittedById: 'submitter-1',
        reviewNote: null,
      });

      const res = await service.triage('partner-1', 'approve');

      expect(res.status).toBe('approved');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PartnerStatus.Approved }),
      );
    });

    it('flips status to rejected and sets reviewNote', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
        submittedById: 'submitter-1',
        reviewNote: null,
      });

      const res = await service.triage(
        'partner-1',
        'reject',
        'Not a fit for the directory',
      );

      expect(res.status).toBe('rejected');
      expect(res.reviewNote).toBe('Not a fit for the directory');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PartnerStatus.Rejected,
          reviewNote: 'Not a fit for the directory',
        }),
      );
    });
  });

  describe('idBySlug / refsByIds', () => {
    it('resolves any partner regardless of status', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
      });
      await expect(service.idBySlug('some-partner')).resolves.toBe('partner-1');
    });

    it('returns null for an unknown slug', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(service.idBySlug('nope')).resolves.toBeNull();
    });

    it('batches id -> {slug,name} refs', async () => {
      partners.find.mockResolvedValue([
        { id: 'partner-1', slug: 'ilga-portugal', name: 'ILGA Portugal' },
      ]);
      const refs = await service.refsByIds(['partner-1']);
      expect(refs.get('partner-1')).toEqual({
        slug: 'ilga-portugal',
        name: 'ILGA Portugal',
      });
    });

    it('short-circuits an empty id list without querying', async () => {
      const refs = await service.refsByIds([]);
      expect(refs.size).toBe(0);
      expect(partners.find).not.toHaveBeenCalled();
    });
  });
});
