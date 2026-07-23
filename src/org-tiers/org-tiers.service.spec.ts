import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OrgTier, OrgTierCtaType } from './entities/org-tier.entity';
import { OrgTiersService } from './org-tiers.service';

describe('OrgTiersService', () => {
  let service: OrgTiersService;
  let tiers: {
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };

  const baseDto = {
    name: 'Standard',
    priceDisplay: '€2.4k',
    pricePeriod: '/year',
    dek: 'For growing organisations.',
    footnote: 'Billed annually.',
    ctaType: OrgTierCtaType.Link,
    ctaLabel: 'Get started',
  };

  beforeEach(async () => {
    tiers = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (mirrors
      // `partners.service.spec.ts`).
      save: jest.fn((t: unknown) =>
        Promise.resolve({
          id: 'tier-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(t as object),
        }),
      ),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrgTiersService,
        { provide: getRepositoryToken(OrgTier), useValue: tiers },
      ],
    }).compile();
    service = module.get(OrgTiersService);
  });

  describe('listPublished', () => {
    it('queries published tiers in display order', async () => {
      await service.listPublished();

      expect(tiers.find).toHaveBeenCalledWith({
        where: { published: true },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
    });

    it('maps rows to the public shape, excluding admin-only fields', async () => {
      tiers.find.mockResolvedValue([
        {
          id: 'tier-1',
          slug: 'standard',
          name: 'Standard',
          priceDisplay: '€2.4k',
          pricePeriod: '/year',
          dek: 'For growing organisations.',
          bullets: ['Feature A', 'Feature B'],
          footnote: 'Billed annually.',
          ctaType: OrgTierCtaType.Link,
          ctaLabel: 'Get started',
          ctaTarget: '/signup',
          featured: true,
          sortOrder: 1,
          published: true,
        },
      ]);

      const [tier] = await service.listPublished();

      expect(tier).toEqual({
        slug: 'standard',
        name: 'Standard',
        priceDisplay: '€2.4k',
        pricePeriod: '/year',
        dek: 'For growing organisations.',
        bullets: ['Feature A', 'Feature B'],
        footnote: 'Billed annually.',
        ctaType: OrgTierCtaType.Link,
        ctaLabel: 'Get started',
        ctaTarget: '/signup',
        featured: true,
      });
      expect(tier).not.toHaveProperty('id');
      expect(tier).not.toHaveProperty('sortOrder');
      expect(tier).not.toHaveProperty('published');
    });
  });

  describe('listAll', () => {
    it('queries every tier (no published filter) in display order', async () => {
      await service.listAll();

      expect(tiers.find).toHaveBeenCalledWith({
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
    });

    it('maps rows to the admin shape, including id/sortOrder/published', async () => {
      tiers.find.mockResolvedValue([
        {
          id: 'tier-1',
          slug: 'standard',
          name: 'Standard',
          priceDisplay: '€2.4k',
          pricePeriod: '/year',
          dek: 'For growing organisations.',
          bullets: [],
          footnote: 'Billed annually.',
          ctaType: OrgTierCtaType.Link,
          ctaLabel: 'Get started',
          ctaTarget: null,
          featured: false,
          sortOrder: 2,
          published: false,
        },
      ]);

      const [tier] = await service.listAll();

      expect(tier.id).toBe('tier-1');
      expect(tier.sortOrder).toBe(2);
      expect(tier.published).toBe(false);
    });
  });

  describe('create', () => {
    it('allocates a slug from the handle when provided', async () => {
      await service.create({ ...baseDto, handle: 'Custom Handle' });

      expect(tiers.save).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'custom-handle' }),
      );
    });

    it('falls back to the name for the slug when no handle is given', async () => {
      await service.create({ ...baseDto });

      expect(tiers.save).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'standard' }),
      );
    });

    it('retries with a suffixed slug when the base slug is already taken', async () => {
      tiers.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await service.create({ ...baseDto });

      const savedArg = tiers.save.mock.calls[0][0] as { slug: string };
      expect(savedArg.slug).toMatch(/^standard-[0-9a-f]{6}$/);
    });

    it('applies defaults for every optional field when omitted', async () => {
      await service.create({ ...baseDto });

      expect(tiers.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bullets: [],
          featured: false,
          published: true,
          sortOrder: 0,
          ctaTarget: null,
        }),
      );
    });

    it('honours explicit values over defaults', async () => {
      await service.create({
        ...baseDto,
        bullets: ['One'],
        featured: true,
        published: false,
        sortOrder: 5,
        ctaTarget: '/apply',
      });

      expect(tiers.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bullets: ['One'],
          featured: true,
          published: false,
          sortOrder: 5,
          ctaTarget: '/apply',
        }),
      );
    });

    it('throws ConflictException when a unique slug cannot be allocated after retries', async () => {
      tiers.exists.mockResolvedValue(false);
      tiers.save.mockImplementation(() => {
        const error: { code: string } = { code: '23505' };
        return Promise.reject(error);
      });

      await expect(service.create({ ...baseDto })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tiers.save).toHaveBeenCalledTimes(5);
    });
  });

  describe('update', () => {
    const existingTier = () => ({
      id: 'tier-1',
      slug: 'standard',
      name: 'Standard',
      priceDisplay: '€2.4k',
      pricePeriod: '/year',
      dek: 'For growing organisations.',
      bullets: ['Feature A'],
      footnote: 'Billed annually.',
      ctaType: OrgTierCtaType.Link,
      ctaLabel: 'Get started',
      ctaTarget: '/signup',
      featured: false,
      sortOrder: 0,
      published: true,
    });

    it('404s an unknown id', async () => {
      tiers.findOne.mockResolvedValue(null);
      await expect(
        service.update('nope', { name: 'New name' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('mutates only the provided fields, leaving the rest untouched', async () => {
      tiers.findOne.mockResolvedValue(existingTier());

      const result = await service.update('tier-1', {
        name: 'Standard Plus',
        featured: true,
      });

      expect(result.name).toBe('Standard Plus');
      expect(result.featured).toBe(true);
      // Untouched fields survive as-is.
      expect(result.priceDisplay).toBe('€2.4k');
      expect(result.dek).toBe('For growing organisations.');
      expect(result.bullets).toEqual(['Feature A']);
      expect(result.published).toBe(true);
      expect(tiers.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Standard Plus', featured: true }),
      );
    });

    it('does not change the slug (immutable post-creation)', async () => {
      tiers.findOne.mockResolvedValue(existingTier());

      await service.update('tier-1', { name: 'Renamed' });

      expect(tiers.save).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'standard' }),
      );
    });

    it('clears ctaTarget to null when explicitly passed null', async () => {
      tiers.findOne.mockResolvedValue(existingTier());

      const result = await service.update('tier-1', { ctaTarget: null });

      expect(result.ctaTarget).toBeNull();
    });
  });

  describe('remove', () => {
    it('404s when delete affects 0 rows', async () => {
      tiers.delete.mockResolvedValue({ affected: 0 });
      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('resolves without error when a row is deleted', async () => {
      tiers.delete.mockResolvedValue({ affected: 1 });
      await expect(service.remove('tier-1')).resolves.toBeUndefined();
      expect(tiers.delete).toHaveBeenCalledWith({ id: 'tier-1' });
    });
  });
});
