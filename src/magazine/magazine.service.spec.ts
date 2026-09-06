import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LessThanOrEqual } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { DeckSlide, MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import { MagazineService } from './magazine.service';

type QueryBuilderMock = {
  select: jest.Mock;
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
  // `listArticles` now projects an explicit column list before filtering
  // (the perf change), so the builder must expose a chainable `.select()`.
  qb.select = jest.fn().mockReturnValue(qb);
  qb.innerJoin = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.addOrderBy = jest.fn().mockReturnValue(qb);
  qb.skip = jest.fn().mockReturnValue(qb);
  qb.take = jest.fn().mockReturnValue(qb);
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return qb;
}

/**
 * The default stub for `articles.createQueryBuilder`, covering both ad-hoc
 * article queries the service runs outside `listArticles`:
 *
 * - CON-11: `listAuthors`/`getAuthorBySlug` run ONE grouped published-piece
 *   count (`select`/`addSelect`/`groupBy`/`getRawMany`).
 * - CON-16: the article read loads this piece's translation family
 *   (`where`/`andWhere`/`getMany`).
 *
 * Both default to an empty result, so those tests exercise the mapping rather
 * than the counting or the translation lookup.
 */
type ArticlesQueryBuilderMock = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  getRawMany: jest.Mock;
  getMany: jest.Mock;
};

function makeArticlesQueryBuilder(): ArticlesQueryBuilderMock {
  const queryBuilder = {} as ArticlesQueryBuilderMock;
  queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.addSelect = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.andWhere = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.groupBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  queryBuilder.getMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
}

/**
 * PRD-111 — `listAuthors` now filters the DIRECTORY down to bylines with at
 * least one published, already-due piece, through an EXISTS subquery on
 * `magazine_article`. That makes it a query builder rather than
 * `authors.find`, so the stub below is what the directory tests drive.
 */
type AuthorsQueryBuilderMock = {
  where: jest.Mock;
  orderBy: jest.Mock;
  getMany: jest.Mock;
};

function makeAuthorsQueryBuilder(
  rows: MagazineAuthor[],
): AuthorsQueryBuilderMock {
  const queryBuilder = {} as AuthorsQueryBuilderMock;
  queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.getMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

/** PRD-106 — the `getOpenIssue` builder (`select`/`where`/`orderBy`/`limit`). */
type IssuesQueryBuilderMock = {
  select: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getOne: jest.Mock;
};

function makeIssuesQueryBuilder(
  row: MagazineIssue | null,
): IssuesQueryBuilderMock {
  const queryBuilder = {} as IssuesQueryBuilderMock;
  queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.addOrderBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.limit = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.getOne = jest.fn().mockResolvedValue(row);
  return queryBuilder;
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

/**
 * Chainable stub for the CON-02 corrections query builder. Every call returns
 * itself so the service's `.innerJoin().where().andWhere().orderBy()` chain
 * runs; `getMany` is what the test controls.
 */
interface CorrectionsQueryBuilderStub {
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  getMany: jest.Mock;
}

const correctionsQueryBuilder: CorrectionsQueryBuilderStub = {
  innerJoin: jest.fn(() => correctionsQueryBuilder),
  where: jest.fn(() => correctionsQueryBuilder),
  andWhere: jest.fn(() => correctionsQueryBuilder),
  orderBy: jest.fn(() => correctionsQueryBuilder),
  addOrderBy: jest.fn(() => correctionsQueryBuilder),
  getMany: jest.fn().mockResolvedValue([]),
};

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
  let authors: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let issues: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let sections: { find: jest.Mock };
  // CON-02 published corrections on the public article read.
  let corrections: { createQueryBuilder: jest.Mock };
  // CON-11 byline -> member link.
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let decks: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  // ENG-112/PRD-131 — deck delete checks for a desk piece still pointing at
  // the deck, and the "With issue" read resolves the deck's issue through
  // that same piece.
  let pieces: { findOne: jest.Mock };

  beforeEach(async () => {
    articles = {
      createQueryBuilder: jest.fn(() => makeArticlesQueryBuilder()),
      findOne: jest.fn(),
    };
    authors = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => makeAuthorsQueryBuilder([])),
    };
    issues = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => makeIssuesQueryBuilder(null)),
    };
    sections = { find: jest.fn().mockResolvedValue([]) };
    // CON-02 — the article read joins published corrections through the staff
    // piece record. Default: this article has never been corrected.
    corrections = {
      createQueryBuilder: jest.fn(() => correctionsQueryBuilder),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    decks = {
      find: jest.fn(),
      findOne: jest.fn(),
      // `create` echoes its input like the real TypeORM repository, so the
      // service's ownership check has run before anything is persisted.
      create: jest.fn((entity: Partial<MagazineDeck>) => entity),
      save: jest.fn(async (entity: Partial<MagazineDeck>) => entity),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    pieces = { findOne: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazineService,
        { provide: getRepositoryToken(MagazineArticle), useValue: articles },
        { provide: getRepositoryToken(MagazineAuthor), useValue: authors },
        { provide: getRepositoryToken(MagazineIssue), useValue: issues },
        {
          provide: getRepositoryToken(MagazineDeck),
          useValue: decks,
        },
        { provide: getRepositoryToken(MagazineSection), useValue: sections },
        {
          provide: getRepositoryToken(MagazineCorrection),
          useValue: corrections,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(MagazinePiece), useValue: pieces },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
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
      // The perf change projects only the columns `toIssueResponse` reads
      // (never the issue-production `runOrder`/`digest`/`coverlines` jsonb),
      // still ordered newest-issue-first. CON-18 added the embargo gate:
      // `published_on <= today`, so an unshipped or scheduled issue never
      // reaches the public archive.
      expect(issues.find).toHaveBeenCalledWith({
        where: {
          publishedOn: LessThanOrEqual(new Date().toISOString().slice(0, 10)),
        },
        select: {
          number: true,
          title: true,
          dek: true,
          publishedOn: true,
          coverUrl: true,
        },
        order: { number: 'DESC' },
      });
    });
  });

  describe('getIssueByNumber', () => {
    it('404s an unknown issue number', async () => {
      issues.findOne.mockResolvedValue(null);
      await expect(service.getIssueByNumber('99')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // CON-18: an embargoed issue is unreachable by number, not merely absent
    // from the archive list.
    it('gates the lookup on published_on <= today', async () => {
      issues.findOne.mockResolvedValue(ISSUE);
      await service.getIssueByNumber('09');
      expect(issues.findOne).toHaveBeenCalledWith({
        where: {
          number: '09',
          publishedOn: LessThanOrEqual(new Date().toISOString().slice(0, 10)),
        },
      });
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
              memberSlug: null,
            },
            issueNumber: '09',
            tags: ['Lisbon', 'Community'],
            readMinutes: 12,
            publishedAt: '2026-06-06T00:00:00.000Z',
            // CON-16 added the lifecycle state and the piece's language to
            // the list projection; CON-04 added the lead art.
            lifecycle: 'live',
            locale: 'en',
            heroImageUrl: null,
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

    it("filters by author slug via an inner join (AuthorPage's Selected work)", async () => {
      const qb = makeQueryBuilder([], 0);
      articles.createQueryBuilder.mockReturnValue(qb);

      await service.listArticles({ author: 'sofia' });

      expect(qb.innerJoin).toHaveBeenCalledWith(
        expect.anything(),
        'byline',
        expect.stringContaining('byline.slug = :authorSlug'),
        { authorSlug: 'sofia' },
      );
    });

    it('drops a row whose author is missing (data-integrity guard)', async () => {
      const qb = makeQueryBuilder([ARTICLE], 1);
      articles.createQueryBuilder.mockReturnValue(qb);
      authors.find.mockResolvedValue([]); // author vanished
      issues.find.mockResolvedValue([ISSUE]);

      const page = await service.listArticles({});
      expect(page.items).toEqual([]);
    });

    it('filters by section via an exact string match (CNT-20 browse)', async () => {
      const qb = makeQueryBuilder([], 0);
      articles.createQueryBuilder.mockReturnValue(qb);

      await service.listArticles({ section: 'Essays' });

      expect(qb.andWhere).toHaveBeenCalledWith('article.section = :section', {
        section: 'Essays',
      });
    });
  });

  describe('listSections', () => {
    it('maps each row to SectionResponse, ordered by orderIndex', async () => {
      sections.find.mockResolvedValue([
        { id: 'section-1', name: 'Essays', target: 4, note: '', orderIndex: 4 },
      ]);

      await expect(service.listSections()).resolves.toEqual([
        { id: 'section-1', name: 'Essays', target: 4, note: '', orderIndex: 4 },
      ]);
      expect(sections.find).toHaveBeenCalledWith({
        order: { orderIndex: 'ASC' },
      });
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
          memberSlug: null,
        },
        issueNumber: '09',
        tags: ['Lisbon', 'Community'],
        readMinutes: 12,
        publishedAt: '2026-06-06T00:00:00.000Z',
        body: 'Full article body text.',
        blocks: [],
        contentNotes: [],
        corrections: [],
        socialImage: null,
        heroImageUrl: null,
        // CON-16 — the lifecycle banner and the language switcher. The
        // switcher always offers the language the reader is already in, so a
        // piece with no translation still lists itself.
        lifecycle: 'live',
        locale: 'en',
        lifecycleNotice: {
          note: '',
          changedAt: null,
          reviewDueOn: null,
          supersededBy: null,
        },
        translations: [
          {
            locale: 'en',
            slug: 'city-changed',
            title: 'The city changed. Did we?',
            isPublished: true,
          },
        ],
        translationOf: null,
        translator: null,
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
      authors.createQueryBuilder.mockReturnValue(
        makeAuthorsQueryBuilder([AUTHOR]),
      );
      await expect(service.listAuthors()).resolves.toEqual([
        {
          slug: 'sofia',
          name: 'Sofia Andrade',
          bio: 'Writes about queer life in Lisbon.',
          avatarUrl: 'https://example.com/sofia.jpg',
          // CON-11: unlinked byline (`userId` null). `pieceCount` is 0 here
          // only because the default articles builder counts nothing back;
          // the EXISTS gate below is what keeps a genuinely empty byline out.
          memberSlug: null,
          pieceCount: 0,
        },
      ]);
    });

    // PRD-111 — the directory advertised bylines the desk had minted when a
    // draft was opened: a "0 pieces" card leading to an author page that said
    // they had not published yet.
    it('gates the directory on an already-due published piece', async () => {
      const queryBuilder = makeAuthorsQueryBuilder([]);
      authors.createQueryBuilder.mockReturnValue(queryBuilder);

      await expect(service.listAuthors()).resolves.toEqual([]);

      const [sql, parameters] = queryBuilder.where.mock.calls[0] as [
        string,
        { now: Date },
      ];
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('magazine_article');
      expect(sql).toContain('article.published_at IS NOT NULL');
      expect(sql).toContain('article.published_at <= :now');
      expect(parameters.now).toBeInstanceOf(Date);
    });

    // The gate must not become a join: an ORDER BY on a joined column is the
    // shape this repo's pagination trap lives in.
    it("orders by the author's own column, with no join", async () => {
      const queryBuilder = makeAuthorsQueryBuilder([]);
      authors.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.listAuthors();

      // The stub exposes no `innerJoin`/`leftJoin`, so a join would throw
      // before this assertion is ever reached.
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('author.name', 'ASC');
    });

    // A byline with no published work is still readable by direct link: the
    // author page, the member "Writing" surface and article bylines all go
    // through `getAuthorBySlug`/`getAuthorForUser`, which are untouched.
    it('still serves an unadvertised byline by slug', async () => {
      authors.createQueryBuilder.mockReturnValue(makeAuthorsQueryBuilder([]));
      authors.findOne.mockResolvedValue(AUTHOR);

      await expect(service.listAuthors()).resolves.toEqual([]);
      await expect(service.getAuthorBySlug('sofia')).resolves.toMatchObject({
        slug: 'sofia',
        pieceCount: 0,
      });
    });
  });

  // PRD-106 — which issue is open for submissions, derived from the issues
  // that have not published yet. The submit-story form used to print a
  // hardcoded issue number and a deadline that had passed.
  describe('getOpenIssue', () => {
    const OPEN_ISSUE: MagazineIssue = {
      number: '27',
      title: 'On work.',
      publishedOn: '2026-10-01',
      submissionDeadline: '2026-09-15',
    } as MagazineIssue;

    it('returns null when every issue has already published', async () => {
      issues.createQueryBuilder.mockReturnValue(makeIssuesQueryBuilder(null));
      await expect(service.getOpenIssue()).resolves.toBeNull();
    });

    it('maps only number, title, publish date and deadline', async () => {
      issues.createQueryBuilder.mockReturnValue(
        makeIssuesQueryBuilder(OPEN_ISSUE),
      );
      await expect(service.getOpenIssue()).resolves.toEqual({
        number: '27',
        title: 'On work.',
        publishedOn: '2026-10-01',
        submissionDeadline: '2026-09-15',
      });
    });

    it('carries a null deadline through rather than inventing one', async () => {
      issues.createQueryBuilder.mockReturnValue(
        makeIssuesQueryBuilder({
          ...OPEN_ISSUE,
          submissionDeadline: null,
        }),
      );
      await expect(service.getOpenIssue()).resolves.toMatchObject({
        submissionDeadline: null,
      });
    });

    it('asks for unpublished issues soonest first, unscheduled last', async () => {
      const queryBuilder = makeIssuesQueryBuilder(null);
      issues.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getOpenIssue();

      const [sql] = queryBuilder.where.mock.calls[0] as [string];
      expect(sql).toContain('issue.published_on IS NULL');
      expect(sql).toContain('issue.published_on > :today');
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        'issue.published_on',
        'ASC',
        'NULLS LAST',
      );
      expect(queryBuilder.limit).toHaveBeenCalledWith(1);
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
        memberSlug: null,
        pieceCount: 0,
      });
    });
  });

  // M1 foreign-upload backstop: a magazine deck is multi-editor and keeps the
  // interceptor's shared-upload exemption, so the service must itself refuse a
  // NEW foreign storage key while allowing an UNCHANGED one to be re-saved.
  describe('deck image ownership (M1)', () => {
    const REQUESTER_ID = '11111111-2222-3333-4444-555555555555';
    const OTHER_EDITOR_ID = '99999999-8888-7777-6666-555555555555';
    const keyOf = (ownerId: string): string =>
      `avatars/${ownerId}/66666666-7777-8888-9999-000000000000.jpg`;
    const OWN_KEY = keyOf(REQUESTER_ID);
    const FOREIGN_KEY = keyOf(OTHER_EDITOR_ID);

    function makeDeck(overrides: Partial<MagazineDeck>): MagazineDeck {
      return {
        id: 'deck-1',
        slug: 'a-deck',
        title: 'A deck',
        kicker: '',
        section: '',
        byline: '',
        role: null,
        authorBio: '',
        cover: '',
        coverDesc: '',
        readTime: '',
        tags: [],
        related: [],
        slides: [],
        publishedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      };
    }

    describe('createDeck', () => {
      it('rejects a foreign cover key (no stored baseline) before persisting', async () => {
        await expect(
          service.createDeck(
            { slug: 'x', title: 'X', cover: FOREIGN_KEY, slides: [] },
            REQUESTER_ID,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(decks.findOne).not.toHaveBeenCalled();
        expect(decks.save).not.toHaveBeenCalled();
      });

      it('rejects a foreign key nested inside an image slide', async () => {
        await expect(
          service.createDeck(
            {
              slug: 'x',
              title: 'X',
              slides: [
                { layout: 'image', src: FOREIGN_KEY, alt: 'a', tint: 'coral' },
              ],
            },
            REQUESTER_ID,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(decks.save).not.toHaveBeenCalled();
      });

      it('allows the creator to reference their own uploaded cover', async () => {
        decks.findOne.mockResolvedValue(null);
        await expect(
          service.createDeck(
            { slug: 'x', title: 'X', cover: OWN_KEY, slides: [] },
            REQUESTER_ID,
          ),
        ).resolves.toMatchObject({ cover: OWN_KEY });
        expect(decks.save).toHaveBeenCalled();
      });
    });

    describe('updateDeck', () => {
      it('allows re-saving the deck’s existing (foreign-uploaded) cover unchanged', async () => {
        decks.findOne.mockResolvedValue(makeDeck({ cover: FOREIGN_KEY }));
        await expect(
          service.updateDeck('deck-1', { cover: FOREIGN_KEY }, REQUESTER_ID),
        ).resolves.toMatchObject({ cover: FOREIGN_KEY });
        expect(decks.save).toHaveBeenCalled();
      });

      it('rejects pointing the cover at a NEW foreign key', async () => {
        decks.findOne.mockResolvedValue(makeDeck({ cover: '' }));
        await expect(
          service.updateDeck('deck-1', { cover: FOREIGN_KEY }, REQUESTER_ID),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(decks.save).not.toHaveBeenCalled();
      });
    });
  });

  // PRD-131 (server-side publish readiness, real scheduling) and ENG-112
  // (deck deletion brought in line with `deletePiece`).
  describe('deck publishing and deletion', () => {
    const EDITOR_ID = '11111111-2222-3333-4444-555555555555';
    const READY_SLIDE: DeckSlide = { layout: 'text', body: 'A slide.' };

    function makeDeck(overrides: Partial<MagazineDeck> = {}): MagazineDeck {
      return {
        id: 'deck-1',
        slug: 'a-deck',
        title: 'A deck',
        kicker: '',
        section: '',
        byline: '',
        role: null,
        authorBio: '',
        cover: '',
        coverDesc: '',
        readTime: '',
        tags: [],
        related: [],
        slides: [READY_SLIDE],
        publishedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      };
    }

    describe('updateDeck publish readiness', () => {
      it('refuses to publish a deck with no slides', async () => {
        decks.findOne.mockResolvedValue(makeDeck({ slides: [] }));
        await expect(
          service.updateDeck('deck-1', { published: true }, EDITOR_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(decks.save).not.toHaveBeenCalled();
      });

      it('refuses to publish when an image slide has blank alt text', async () => {
        // Reaches the readiness check only because the row is already stored
        // this way: `validateDeckSlides` would reject the same slides on the
        // way in, which is exactly the gap the second check closes.
        decks.findOne.mockResolvedValue(
          makeDeck({
            slides: [
              {
                layout: 'image',
                src: 'https://x/a.jpg',
                alt: '  ',
                tint: 'coral',
              },
            ],
          }),
        );
        await expect(
          service.updateDeck('deck-1', { published: true }, EDITOR_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(decks.save).not.toHaveBeenCalled();
      });

      it('publishes a ready deck and stamps publishedAt', async () => {
        decks.findOne.mockResolvedValue(makeDeck());
        const response = await service.updateDeck(
          'deck-1',
          { published: true },
          EDITOR_ID,
        );
        expect(response.publishedAt).not.toBeNull();
      });

      it('accepts a slides payload that fixes readiness in the same PATCH', async () => {
        decks.findOne.mockResolvedValue(makeDeck({ slides: [] }));
        const response = await service.updateDeck(
          'deck-1',
          { slides: [READY_SLIDE], published: true },
          EDITOR_ID,
        );
        expect(response.publishedAt).not.toBeNull();
      });

      it('never gates unpublishing, whatever shape the deck is in', async () => {
        decks.findOne.mockResolvedValue(
          makeDeck({ slides: [], publishedAt: new Date() }),
        );
        const response = await service.updateDeck(
          'deck-1',
          { published: false },
          EDITOR_ID,
        );
        expect(response.publishedAt).toBeNull();
      });

      it('schedules at a future instant when publishedAt is sent', async () => {
        decks.findOne.mockResolvedValue(makeDeck());
        const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
        const response = await service.updateDeck(
          'deck-1',
          { publishedAt: scheduledAt },
          EDITOR_ID,
        );
        expect(response.publishedAt).toEqual(scheduledAt);
      });

      it('lets publishedAt win over the boolean when both are sent', async () => {
        decks.findOne.mockResolvedValue(makeDeck({ publishedAt: new Date() }));
        const response = await service.updateDeck(
          'deck-1',
          { published: true, publishedAt: null },
          EDITOR_ID,
        );
        expect(response.publishedAt).toBeNull();
      });

      it('leaves the publish state alone when neither control is sent', async () => {
        const publishedAt = new Date('2026-02-02T00:00:00.000Z');
        decks.findOne.mockResolvedValue(makeDeck({ publishedAt }));
        const response = await service.updateDeck(
          'deck-1',
          { title: 'Renamed' },
          EDITOR_ID,
        );
        expect(response.publishedAt).toEqual(publishedAt.toISOString());
      });
    });

    describe('deleteDeck', () => {
      it('404s on an unknown deck', async () => {
        decks.findOne.mockResolvedValue(null);
        await expect(service.deleteDeck('deck-1')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(decks.delete).not.toHaveBeenCalled();
      });

      it('refuses to hard-delete a published deck (unpublish first)', async () => {
        decks.findOne.mockResolvedValue(makeDeck({ publishedAt: new Date() }));
        await expect(service.deleteDeck('deck-1')).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(decks.delete).not.toHaveBeenCalled();
      });

      it('refuses to orphan a desk piece that still points at the deck', async () => {
        decks.findOne.mockResolvedValue(makeDeck());
        pieces.findOne.mockResolvedValue({ id: 'piece-1' });
        await expect(service.deleteDeck('deck-1')).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(decks.delete).not.toHaveBeenCalled();
      });

      it('deletes a standalone draft deck', async () => {
        decks.findOne.mockResolvedValue(makeDeck());
        pieces.findOne.mockResolvedValue(null);
        await expect(service.deleteDeck('deck-1')).resolves.toBeUndefined();
        expect(decks.delete).toHaveBeenCalledWith('deck-1');
      });
    });

    describe('getDeckIssueLink', () => {
      it('returns nulls when no piece links the deck', async () => {
        decks.findOne.mockResolvedValue(makeDeck());
        pieces.findOne.mockResolvedValue(null);
        await expect(service.getDeckIssueLink('deck-1')).resolves.toEqual({
          pieceId: null,
          issueNumber: null,
          issueTitle: null,
        });
      });

      it('names the issue the linked piece is filed under', async () => {
        decks.findOne.mockResolvedValue(makeDeck());
        pieces.findOne.mockResolvedValue({ id: 'piece-1', issueId: 'issue-1' });
        issues.findOne.mockResolvedValue({ number: '27', title: 'On work.' });
        await expect(service.getDeckIssueLink('deck-1')).resolves.toEqual({
          pieceId: 'piece-1',
          issueNumber: '27',
          issueTitle: 'On work.',
        });
      });
    });
  });
});
