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
  for (const m of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getMany = jest.fn().mockResolvedValue([]);
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
    meta: 'Guide · 12 min · PT / EN',
    externalUrl: null,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastVerifiedAt: null,
    titlePt: null,
    descriptionPt: null,
    sections: [],
    sectionsPt: null,
    routePath: '/safety/legal',
    // Published is no longer enough to be public: a guide only reaches a
    // reader once an editor has stamped a review, so the "visible" fixture
    // carries one. The never-reviewed case gets its own tests below.
    reviewDueOn: '2027-01-01',
    lastReviewedOn: '2026-01-01',
    reviewedBy: 'Trans Hub',
    updatedBy: null,
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
    definitionPt: null,
    reviewDueOn: null,
    lastReviewedOn: null,
    reviewedBy: null,
    updatedBy: null,
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

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        where: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('r.publishedAt IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('r.publishedAt <= :now', {
        now: expect.any(Date) as Date,
      });
    });

    // A guide nobody has read end to end must not reach a reader looking for
    // a crisis line or a legal deadline, however long ago it was published.
    it('excludes guides no editor has reviewed', async () => {
      await service.list({});

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('r.lastReviewedOn IS NOT NULL');
    });

    // Hiding a health guide because a calendar date passed is worse than the
    // reader footer printing an honestly stale date, so nothing filters on
    // `reviewDueOn`.
    it('does not hide a guide whose review has merely fallen due', async () => {
      await service.list({});

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('reviewDueOn'),
        expect.anything(),
      );
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('reviewDueOn'),
      );
    });

    it('adds a category filter when provided', async () => {
      await service.list({ category: 'legal' });

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('r.category = :category', {
        category: 'legal',
      });
    });

    it('omits the category filter when none is provided', async () => {
      await service.list({});

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('category'),
        expect.anything(),
      );
    });

    it('maps rows to ResourceResponse and returns the page envelope', async () => {
      const qb = qbStub();
      qb.getManyAndCount!.mockResolvedValue([[publishedResource], 1]);
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
            meta: 'Guide · 12 min · PT / EN',
            externalUrl: null,
            // Editorial freshness: the reader shows "last checked ‹date›", so
            // an unverified resource has to map to an explicit null rather
            // than be absent from the response.
            lastVerifiedAt: null,
            // CON-08/CON-09 additions: the Portuguese copy, the structured
            // prose (empty here — this guide is metadata-only and the
            // frontend keeps its hardcoded page), the route the guide is
            // addressable at, and the review trail.
            titlePt: null,
            descriptionPt: null,
            sections: [],
            sectionsPt: null,
            routePath: '/safety/legal',
            lastReviewedOn: '2026-01-01',
            reviewedBy: 'Trans Hub',
            reviewDueOn: '2027-01-01',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });
  });

  // `listIndex` and `searchByText` share `applyPublicGate` with `list`, but
  // they are separate call sites: an inlined rewrite of either one would put
  // unreviewed guides back in front of readers without failing `list`'s tests.
  describe('listIndex', () => {
    it('serves only published guides an editor has reviewed', async () => {
      await service.listIndex();

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        where: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('r.publishedAt IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('r.lastReviewedOn IS NOT NULL');
    });
  });

  describe('searchByText', () => {
    it('never surfaces an unreviewed guide in global search', async () => {
      await service.searchByText('discrimination', 5);

      const qb = resources.createQueryBuilder.mock.results[0]!.value as {
        where: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('r.publishedAt IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('r.lastReviewedOn IS NOT NULL');
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

    it('404s a published guide no editor has ever reviewed', async () => {
      resources.findOne.mockResolvedValue({
        ...publishedResource,
        lastReviewedOn: null,
        reviewedBy: null,
      });
      await expect(
        service.getBySlug('workplace-discrimination-guide'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // The frontend reads this 404 as "not managed in the database yet" and
    // falls back to the hardcoded page, so an overdue review must not trigger
    // it — that would silently strip an editor's prose off a live guide.
    it('serves a guide whose review has fallen due', async () => {
      resources.findOne.mockResolvedValue({
        ...publishedResource,
        lastReviewedOn: '2020-01-01',
        reviewDueOn: '2020-07-01',
      });

      const detail = await service.getBySlug('workplace-discrimination-guide');

      expect(detail.lastReviewedOn).toBe('2020-01-01');
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
        meta: 'Guide · 12 min · PT / EN',
        externalUrl: null,
        lastVerifiedAt: null,
        titlePt: null,
        descriptionPt: null,
        sections: [],
        sectionsPt: null,
        routePath: '/safety/legal',
        lastReviewedOn: '2026-01-01',
        reviewedBy: 'Trans Hub',
        reviewDueOn: '2027-01-01',
      });
    });

    it('serves an ISO lastVerifiedAt when the resource has been checked', async () => {
      resources.findOne.mockResolvedValue({
        ...publishedResource,
        lastVerifiedAt: new Date('2026-06-01T09:30:00.000Z'),
      });

      const detail = await service.getBySlug('workplace-discrimination-guide');

      expect(detail.lastVerifiedAt).toBe('2026-06-01T09:30:00.000Z');
    });
  });

  describe('listGlossary', () => {
    it('lists every term ordered alphabetically when no category is given', async () => {
      await service.listGlossary();
      expect(glossaryTerms.find).toHaveBeenCalledWith({
        where: {},
        order: { term: 'ASC' },
        take: 200,
      });
    });

    it('filters by category when provided', async () => {
      await service.listGlossary('Essential');
      expect(glossaryTerms.find).toHaveBeenCalledWith({
        where: { category: 'Essential' },
        order: { term: 'ASC' },
        take: 200,
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
          definitionPt: null,
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
        definitionPt: null,
        category: 'Essential',
      });
    });
  });
});
