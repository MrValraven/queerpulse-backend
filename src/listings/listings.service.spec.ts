import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { ListingsService } from './listings.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  ownerId: 'owner-1',
  status: ListingStatus.Review,
  path: 'claim',
  verify: '',
  name: 'Lux Café',
  cats: [],
  hood: 'Arroios',
  badge: '',
  evidence: '',
  price: '',
  blurb: '',
  tagline: '',
  whatItIs: [],
  tags: [],
  goodFor: [],
  langs: [],
  address: '',
  geocoded: false,
  hours: {},
  hoursNote: '',
  social: { instagram: '', website: '', email: '', phone: '' },
  photos: { wide: '', d1: '', d2: '', vibe: '' },
  alt: { wide: '', d1: '', d2: '', vibe: '' },
  rel: '',
  ownerName: '',
  ownerRole: '',
  ownerBio: '',
  visibility: 'public',
  linkToProfile: false,
  contactEmail: '',
  notify: [],
  consentOuting: false,
  consentGuide: false,
  isPartneredWithQueerpulse: false,
  spaceType: '',
  capacity: null,
  hostNote: '',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ListingsService', () => {
  let service: ListingsService;
  let listings: {
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (mirrors
      // `partners.service.spec.ts`'s identical precedent).
      save: jest.fn((v: object) =>
        Promise.resolve({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...v,
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    dataSource = { query: jest.fn().mockResolvedValue([{ seq: '1' }]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(ListingsService);
  });

  describe('create', () => {
    it('allocates a QPL-<year>-<seq> ref and a slug, defaulting to Review', async () => {
      const dto = { name: 'Lux Café' };
      const result = await service.create('owner-1', dto);

      const year = new Date().getFullYear();
      expect(result.ref).toBe(`QPL-${year}-0001`);
      expect(result.slug).toBe('lux-cafe');
      expect(result.status).toBe(ListingStatus.Review);
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'owner-1',
          status: ListingStatus.Review,
          name: 'Lux Café',
        }),
      );
    });

    it('defaults every optional draft field so nothing is undefined', async () => {
      await service.create('owner-1', { name: 'Lux Café' });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          cats: [],
          tags: [],
          social: { instagram: '', website: '', email: '', phone: '' },
          photos: { wide: '', d1: '', d2: '', vibe: '' },
          consentOuting: false,
        }),
      );
    });

    it('retries the slug on a 23505 unique-violation race', async () => {
      listings.exists
        .mockResolvedValueOnce(true) // first candidate taken
        .mockResolvedValueOnce(false);

      const result = await service.create('owner-1', { name: 'Lux Café' });
      expect(result.slug).toBeDefined();
      expect(listings.exists).toHaveBeenCalledTimes(2);
    });
  });

  describe('listMine', () => {
    it('scopes the query to the caller and paginates', async () => {
      await service.listMine('owner-1', { page: 2 });

      const qb = listings.createQueryBuilder.mock.results[0].value as {
        where: jest.Mock;
        skip: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('l.owner_id = :ownerId', {
        ownerId: 'owner-1',
      });
      expect(qb.skip).toHaveBeenCalled();
    });
  });

  describe('getByRef', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.getByRef('QPL-2026-9999', 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a caller who does not own the listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.getByRef('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the listing to its owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      const dto = await service.getByRef('QPL-2026-0001', 'owner-1');
      expect(dto.ref).toBe('QPL-2026-0001');
      expect(dto.name).toBe('Lux Café');
    });
  });

  describe('update', () => {
    it('403s a non-owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.update('QPL-2026-0001', 'someone-else', { blurb: 'nope' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('patches only the given fields for the owner', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: 'owner-1', blurb: 'old' }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        blurb: 'new blurb',
      });

      expect(dto.blurb).toBe('new blurb');
      expect(dto.name).toBe('Lux Café'); // untouched field preserved
    });

    it('merges partial social/photos patches instead of replacing the whole object', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: 'owner-1',
          social: {
            instagram: '@lux',
            website: '',
            email: 'a@b.com',
            phone: '',
          },
        }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        social: { phone: '+351123' },
      });

      expect(dto.social).toEqual({
        instagram: '@lux',
        website: '',
        email: 'a@b.com',
        phone: '+351123',
      });
    });
  });

  describe('remove', () => {
    it('403s a non-owner and does not delete', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.remove('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(listings.remove).not.toHaveBeenCalled();
    });

    it('removes the listing for its owner', async () => {
      const listing = baseListing({ ownerId: 'owner-1' });
      listings.findOne.mockResolvedValue(listing);

      await service.remove('QPL-2026-0001', 'owner-1');
      expect(listings.remove).toHaveBeenCalledWith(listing);
    });
  });

  describe('setStatus', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.setStatus('QPL-2026-9999', ListingStatus.Live),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('transitions review -> live', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ status: ListingStatus.Review }),
      );
      const dto = await service.setStatus('QPL-2026-0001', ListingStatus.Live);
      expect(dto.status).toBe(ListingStatus.Live);
    });

    it('transitions review -> question', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ status: ListingStatus.Review }),
      );
      const dto = await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Question,
      );
      expect(dto.status).toBe(ListingStatus.Question);
    });
  });
});
