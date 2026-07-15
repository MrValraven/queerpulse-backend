import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazineService } from './magazine.service';

type QueryBuilderMock = {
  innerJoin: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getManyAndCount: jest.Mock;
};

function makeQueryBuilder(
  rows: MagazineArticle[],
  total: number,
): QueryBuilderMock {
  const qb = {} as QueryBuilderMock;
  qb.innerJoin = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.addOrderBy = jest.fn().mockReturnValue(qb);
  qb.skip = jest.fn().mockReturnValue(qb);
  qb.take = jest.fn().mockReturnValue(qb);
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return qb;
}

const AUTHOR: MagazineAuthor = {
  id: 'author-1',
  slug: 'sofia',
  name: 'Sofia Andrade',
  bio: 'Writes about queer life in Lisbon.',
  avatarUrl: 'https://example.com/sofia.jpg',
} as MagazineAuthor;

const ISSUE: MagazineIssue = {
  id: 'issue-1',
  number: '09',
  title: 'On health.',
  dek: 'Twelve pieces about how we keep our bodies, our minds, and each other.',
  publishedOn: '2026-06-06',
  coverUrl: null,
} as MagazineIssue;

const ARTICLE: MagazineArticle = {
  id: 'article-1',
  slug: 'city-changed',
  title: 'The city changed. Did we?',
  dek: "Lisbon's queer community has spent a decade finding itself.",
  body: 'Full article body text.',
  authorId: 'author-1',
  issueId: 'issue-1',
  tags: ['Lisbon', 'Community'],
  readMinutes: 12,
  publishedAt: new Date('2026-06-06T00:00:00.000Z'),
} as MagazineArticle;

describe('MagazineService', () => {
  let service: MagazineService;
  let articles: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
  };
  let authors: { find: jest.Mock; findOne: jest.Mock };
  let issues: { find: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    articles = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    };
    authors = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
    issues = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazineService,
        { provide: getRepositoryToken(MagazineArticle), useValue: articles },
        { provide: getRepositoryToken(MagazineAuthor), useValue: authors },
        { provide: getRepositoryToken(MagazineIssue), useValue: issues },
      ],
    }).compile();
    service = module.get(MagazineService);
  });

  describe('listIssues', () => {
    it('maps each row to IssueResponse verbatim', async () => {
      issues.find.mockResolvedValue([ISSUE]);
      await expect(service.listIssues()).resolves.toEqual([
        {
          number: '09',
          title: 'On health.',
          dek: 'Twelve pieces about how we keep our bodies, our minds, and each other.',
          publishedOn: '2026-06-06',
          coverUrl: null,
        },
      ]);
      expect(issues.find).toHaveBeenCalledWith({ order: { number: 'DESC' } });
    });
  });

  describe('getIssueByNumber', () => {
    it('404s an unknown issue number', async () => {
      issues.findOne.mockResolvedValue(null);
      await expect(service.getIssueByNumber('99')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the mapped issue when found', async () => {
      issues.findOne.mockResolvedValue(ISSUE);
      await expect(service.getIssueByNumber('09')).resolves.toMatchObject({
        number: '09',
        title: 'On health.',
      });
    });
  });

  describe('listArticles', () => {
    it('maps rows to ArticleListItem, resolving author + issue number', async () => {
      const qb = makeQueryBuilder([ARTICLE], 1);
      articles.createQueryBuilder.mockReturnValue(qb);
      authors.find.mockResolvedValue([AUTHOR]);
      issues.find.mockResolvedValue([ISSUE]);

      const page = await service.listArticles({ page: 1 });

      expect(page).toEqual({
        items: [
          {
            slug: 'city-changed',
            title: 'The city changed. Did we?',
            dek: "Lisbon's queer community has spent a decade finding itself.",
            author: {
              handle: 'sofia',
              displayName: 'Sofia Andrade',
              avatarUrl: 'https://example.com/sofia.jpg',
            },
            issueNumber: '09',
            tags: ['Lisbon', 'Community'],
            readMinutes: 12,
            publishedAt: '2026-06-06T00:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      // The list item never carries a `body` field.
      expect(page.items[0]).not.toHaveProperty('body');
    });

    it('filters by issue number via an inner join', async () => {
      const qb = makeQueryBuilder([], 0);
      articles.createQueryBuilder.mockReturnValue(qb);

      await service.listArticles({ issue: '09' });

      expect(qb.innerJoin).toHaveBeenCalledWith(
        expect.anything(),
        'issue',
        expect.stringContaining('issue.number = :issueNumber'),
        { issueNumber: '09' },
      );
    });

    it('filters by tag via an array-contains predicate', async () => {
      const qb = makeQueryBuilder([], 0);
      articles.createQueryBuilder.mockReturnValue(qb);

      await service.listArticles({ tag: 'Housing' });

      expect(qb.andWhere).toHaveBeenCalledWith(':tag = ANY(article.tags)', {
        tag: 'Housing',
      });
    });

    it('drops a row whose author is missing (data-integrity guard)', async () => {
      const qb = makeQueryBuilder([ARTICLE], 1);
      articles.createQueryBuilder.mockReturnValue(qb);
      authors.find.mockResolvedValue([]); // author vanished
      issues.find.mockResolvedValue([ISSUE]);

      const page = await service.listArticles({});
      expect(page.items).toEqual([]);
    });
  });

  describe('getArticleBySlug', () => {
    it('404s an unknown slug', async () => {
      articles.findOne.mockResolvedValue(null);
      await expect(service.getArticleBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the full ArticleResponse, including body', async () => {
      articles.findOne.mockResolvedValue(ARTICLE);
      authors.findOne.mockResolvedValue(AUTHOR);
      issues.findOne.mockResolvedValue(ISSUE);

      await expect(service.getArticleBySlug('city-changed')).resolves.toEqual({
        slug: 'city-changed',
        title: 'The city changed. Did we?',
        dek: "Lisbon's queer community has spent a decade finding itself.",
        author: {
          handle: 'sofia',
          displayName: 'Sofia Andrade',
          avatarUrl: 'https://example.com/sofia.jpg',
        },
        issueNumber: '09',
        tags: ['Lisbon', 'Community'],
        readMinutes: 12,
        publishedAt: '2026-06-06T00:00:00.000Z',
        body: 'Full article body text.',
      });
    });

    it('returns issueNumber null for a web-only article (no issue)', async () => {
      articles.findOne.mockResolvedValue({ ...ARTICLE, issueId: null });
      authors.findOne.mockResolvedValue(AUTHOR);

      const result = await service.getArticleBySlug('city-changed');
      expect(result.issueNumber).toBeNull();
      expect(issues.findOne).not.toHaveBeenCalled();
    });
  });

  describe('listAuthors', () => {
    it('maps each row to AuthorResponse verbatim', async () => {
      authors.find.mockResolvedValue([AUTHOR]);
      await expect(service.listAuthors()).resolves.toEqual([
        {
          slug: 'sofia',
          name: 'Sofia Andrade',
          bio: 'Writes about queer life in Lisbon.',
          avatarUrl: 'https://example.com/sofia.jpg',
        },
      ]);
    });
  });

  describe('getAuthorBySlug', () => {
    it('404s an unknown slug', async () => {
      authors.findOne.mockResolvedValue(null);
      await expect(service.getAuthorBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the mapped author when found', async () => {
      authors.findOne.mockResolvedValue(AUTHOR);
      await expect(service.getAuthorBySlug('sofia')).resolves.toEqual({
        slug: 'sofia',
        name: 'Sofia Andrade',
        bio: 'Writes about queer life in Lisbon.',
        avatarUrl: 'https://example.com/sofia.jpg',
      });
    });
  });
});
