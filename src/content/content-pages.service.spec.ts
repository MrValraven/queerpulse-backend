import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentPagesService } from './content-pages.service';
import { ContentPage, ContentSection } from './entities/content-page.entity';

describe('ContentPagesService', () => {
  let service: ContentPagesService;
  let pages: {
    find: jest.Mock;
    findOne: jest.Mock;
  };

  const publishedPage: ContentPage = {
    id: 'page-1',
    section: ContentSection.Governance,
    slug: 'moderation',
    title: 'How moderation works',
    body: 'A report can be filed by any member…',
    locale: 'en',
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    pages = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContentPagesService,
        { provide: getRepositoryToken(ContentPage), useValue: pages },
      ],
    }).compile();
    service = module.get(ContentPagesService);
  });

  describe('listBySection', () => {
    it('queries the section filtered to published-or-earlier, newest first', async () => {
      await service.listBySection(ContentSection.Governance);

      const calls = pages.find.mock.calls as Array<
        [
          {
            where: { section: ContentSection; publishedAt: unknown };
            order: { publishedAt: string };
          },
        ]
      >;
      const opts = calls[0][0];
      expect(opts.where.section).toBe(ContentSection.Governance);
      // A `LessThanOrEqual(now)` FindOperator excludes NULL / future rows.
      expect(opts.where.publishedAt).toBeDefined();
      expect(opts.order).toEqual({ publishedAt: 'DESC' });
    });

    it('maps rows to PageResponse[]', async () => {
      pages.find.mockResolvedValue([publishedPage]);

      const list = await service.listBySection(ContentSection.Governance);

      expect(list).toEqual([
        {
          slug: 'moderation',
          title: 'How moderation works',
          body: 'A report can be filed by any member…',
          locale: 'en',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    it('returns an empty array when the section has no pages', async () => {
      const list = await service.listBySection(ContentSection.Culture);
      expect(list).toEqual([]);
    });
  });

  describe('getBySlug', () => {
    it('scopes the lookup to the requested section and slug', async () => {
      pages.findOne.mockResolvedValue(publishedPage);

      await service.getBySlug(ContentSection.Governance, 'moderation');

      expect(pages.findOne).toHaveBeenCalledWith({
        where: { section: ContentSection.Governance, slug: 'moderation' },
      });
    });

    it('404s an unknown slug', async () => {
      pages.findOne.mockResolvedValue(null);
      await expect(
        service.getBySlug(ContentSection.Culture, 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a page with no publishedAt (hides existence from the public)', async () => {
      pages.findOne.mockResolvedValue({ ...publishedPage, publishedAt: null });
      await expect(
        service.getBySlug(ContentSection.Governance, 'moderation'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a future-dated (not-yet-published) page', async () => {
      pages.findOne.mockResolvedValue({
        ...publishedPage,
        publishedAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });
      await expect(
        service.getBySlug(ContentSection.Governance, 'moderation'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the full PageResponse for a published page', async () => {
      pages.findOne.mockResolvedValue(publishedPage);

      const detail = await service.getBySlug(
        ContentSection.Governance,
        'moderation',
      );

      expect(detail).toEqual({
        slug: 'moderation',
        title: 'How moderation works',
        body: 'A report can be filed by any member…',
        locale: 'en',
        publishedAt: '2026-01-01T00:00:00.000Z',
      });
    });
  });
});
