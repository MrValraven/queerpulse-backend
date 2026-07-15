import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GlossaryTerm } from './entities/glossary-term.entity';
import { Resource } from './entities/resource.entity';
import { ResourcesService } from './resources.service';

// A chainable query-builder stub whose terminal method resolves to empty
// results by default (mirrors `partners.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('ResourcesService', () => {
  let service: ResourcesService;
  let resources: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let glossaryTerms: {
    find: jest.Mock;
    findOne: jest.Mock;
  };

  const publishedResource: Resource = {
    id: 'resource-1',
    slug: 'workplace-discrimination-guide',
    category: 'legal',
    title: 'Workplace discrimination — the full guide',
    description:
      "What Portugal's Labour Code protects, how to document incidents, and a template complaint letter for the ACT.",
    body: 'Full guide body text…',
    externalUrl: null,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const glossaryTerm: GlossaryTerm = {
    id: 'term-1',
    slug: 'chosen-family',
    term: 'Chosen family',
    definition:
      'The set of intentional, ongoing relationships of care that queer people build.',
    category: 'Essential',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    resources = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    glossaryTerms = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourcesService,
        { provide: getRepositoryToken(Resource), useValue: resources },
        { provide: getRepositoryToken(GlossaryTerm), useValue: glossaryTerms },
      ],
    }).compile();
    service = module.get(ResourcesService);
  });

  describe('list', () => {
    it('filters to published resources only', async () => {
      await service.list({});

      const qb = resources.createQueryBuilder.mock.results[0].value as {
        where: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('r.publishedAt IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('r.publishedAt <= :now', {
        now: expect.any(Date) as Date,
      });
    });

    it('adds a category filter when provided', async () => {
      await service.list({ category: 'legal' });

      const qb = resources.createQueryBuilder.mock.results[0].value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('r.category = :category', {
        category: 'legal',
      });
    });

    it('omits the category filter when none is provided', async () => {
      await service.list({});

      const qb = resources.createQueryBuilder.mock.results[0].value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('category'),
        expect.anything(),
      );
    });

    it('maps rows to ResourceResponse and returns the page envelope', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[publishedResource], 1]);
      resources.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list({});

      expect(page).toEqual({
        items: [
          {
            slug: 'workplace-discrimination-guide',
            category: 'legal',
            title: 'Workplace discrimination — the full guide',
            description:
              "What Portugal's Labour Code protects, how to document incidents, and a template complaint letter for the ACT.",
            body: 'Full guide body text…',
            externalUrl: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });
  });

  describe('getBySlug', () => {
    it('404s an unknown slug', async () => {
      resources.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s a resource with no publishedAt (hides existence from the public)', async () => {
      resources.findOne.mockResolvedValue({
        ...publishedResource,
        publishedAt: null,
      });
      await expect(
        service.getBySlug('workplace-discrimination-guide'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a future-dated (not-yet-published) resource', async () => {
      resources.findOne.mockResolvedValue({
        ...publishedResource,
        publishedAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });
      await expect(
        service.getBySlug('workplace-discrimination-guide'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the full ResourceResponse (with body) for a published resource', async () => {
      resources.findOne.mockResolvedValue(publishedResource);

      const detail = await service.getBySlug('workplace-discrimination-guide');

      expect(detail).toEqual({
        slug: 'workplace-discrimination-guide',
        category: 'legal',
        title: 'Workplace discrimination — the full guide',
        description:
          "What Portugal's Labour Code protects, how to document incidents, and a template complaint letter for the ACT.",
        body: 'Full guide body text…',
        externalUrl: null,
      });
    });
  });

  describe('listGlossary', () => {
    it('lists every term ordered alphabetically when no category is given', async () => {
      await service.listGlossary();
      expect(glossaryTerms.find).toHaveBeenCalledWith({
        where: {},
        order: { term: 'ASC' },
      });
    });

    it('filters by category when provided', async () => {
      await service.listGlossary('Essential');
      expect(glossaryTerms.find).toHaveBeenCalledWith({
        where: { category: 'Essential' },
        order: { term: 'ASC' },
      });
    });

    it('maps rows to GlossaryTermResponse', async () => {
      glossaryTerms.find.mockResolvedValue([glossaryTerm]);
      const terms = await service.listGlossary();
      expect(terms).toEqual([
        {
          slug: 'chosen-family',
          term: 'Chosen family',
          definition:
            'The set of intentional, ongoing relationships of care that queer people build.',
          category: 'Essential',
        },
      ]);
    });

    it('returns an empty array when nothing matches', async () => {
      const terms = await service.listGlossary('nope');
      expect(terms).toEqual([]);
    });
  });

  describe('getGlossaryBySlug', () => {
    it('404s an unknown slug', async () => {
      glossaryTerms.findOne.mockResolvedValue(null);
      await expect(service.getGlossaryBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the GlossaryTermResponse for a known slug', async () => {
      glossaryTerms.findOne.mockResolvedValue(glossaryTerm);
      const term = await service.getGlossaryBySlug('chosen-family');
      expect(term).toEqual({
        slug: 'chosen-family',
        term: 'Chosen family',
        definition:
          'The set of intentional, ongoing relationships of care that queer people build.',
        category: 'Essential',
      });
    });
  });
});
