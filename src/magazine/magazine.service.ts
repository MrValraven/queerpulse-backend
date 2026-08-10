import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { validateDeckSlides } from './deck-slides.validation';
import { CreateDeckDto } from './dto/create-deck.dto';
import { UpdateDeckDto } from './dto/update-deck.dto';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import {
  ArticleListItem,
  ArticleResponse,
  ArticleSearchRow,
  AuthorResponse,
  DeckListItemResponse,
  DeckResponse,
  IssueResponse,
  toArticleListItem,
  toArticleResponse,
  toArticleSearchRow,
  toAuthorResponse,
  toDeckListItem,
  toDeckResponse,
  toIssueResponse,
} from './magazine-response';

export interface ListArticlesInput {
  issue?: string;
  tag?: string;
  author?: string;
  page?: number;
}

export interface ListDecksInput {
  tag?: string;
  page?: number;
}

/**
 * Read side of the magazine module: issues, articles, authors. Seed + read
 * only per the spec (§3 Tier 5 "magazine") — the one write endpoint (story
 * submissions) lives in `StorySubmissionsService`.
 */
@Injectable()
export class MagazineService {
  constructor(
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineAuthor)
    private readonly authors: Repository<MagazineAuthor>,
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(MagazineDeck)
    private readonly decks: Repository<MagazineDeck>,
  ) {}

  async listIssues(): Promise<IssueResponse[]> {
    // Project only what `toIssueResponse` reads — the full row also carries
    // the `runOrder`/`digest`/`coverlines` jsonb (issue-production data),
    // none of which this public read ever maps.
    const rows = await this.issues.find({
      select: {
        number: true,
        title: true,
        dek: true,
        publishedOn: true,
        coverUrl: true,
      },
      order: { number: 'DESC' },
    });
    return rows.map(toIssueResponse);
  }

  async getIssueByNumber(number: string): Promise<IssueResponse> {
    const issue = await this.issues.findOne({ where: { number } });
    if (!issue) {
      throw new NotFoundException('Issue not found');
    }
    return toIssueResponse(issue);
  }

  async listArticles(
    query: ListArticlesInput,
  ): Promise<Paginated<ArticleListItem>> {
    const page = normalizePage(query.page);
    const qb = this.articles
      .createQueryBuilder('article')
      // Project only what `toArticleListItem` (via `toListItems`) reads, plus
      // `authorId`/`issueId` (needed to build the batched author/issue
      // lookups below) and `createdAt` (the ORDER BY tiebreaker). The full
      // row also carries the block-editor `blocks` jsonb, legacy `body` text,
      // and `contentNotes` — none of which this list ever maps.
      .select([
        'article.id',
        'article.slug',
        'article.title',
        'article.dek',
        'article.tags',
        'article.readMinutes',
        'article.publishedAt',
        'article.authorId',
        'article.issueId',
        'article.createdAt',
      ])
      // Published only: `published_at` set and not in the future. Unpublished
      // (NULL) rows drop out because `NULL <= :now` is unknown, not true —
      // mirrors `ResourcesService.list` / `ContentPagesService.listBySection`.
      .andWhere('article.published_at <= :now', { now: new Date() });

    if (query.issue) {
      qb.innerJoin(
        MagazineIssue,
        'issue',
        'issue.id = article.issue_id AND issue.number = :issueNumber',
        { issueNumber: query.issue },
      );
    }
    if (query.tag) {
      qb.andWhere(':tag = ANY(article.tags)', { tag: query.tag });
    }
    if (query.author) {
      qb.innerJoin(
        MagazineAuthor,
        'byline',
        'byline.id = article.author_id AND byline.slug = :authorSlug',
        { authorSlug: query.author },
      );
    }

    // Property paths (`publishedAt`/`createdAt`), not raw DB columns: when the
    // `?author=` byline join above is present, `paginate` (skip/take) sends this
    // through TypeORM's distinct-id pagination pass, which resolves ORDER BY via
    // `findColumnWithPropertyPath` and throws `undefined.databaseName` on a raw
    // column name.
    qb.orderBy('article.publishedAt', 'DESC', 'NULLS LAST').addOrderBy(
      'article.createdAt',
      'DESC',
    );

    return paginate(qb, page, (rows) => this.toListItems(rows));
  }

  // Cross-entity global search (SearchService) — published articles only
  // (same `published_at <= now` gate as `listArticles`, so unpublished/
  // future-dated pieces never surface). ILIKE over title / dek. No author or
  // issue hydration — the search row needs neither.
  async searchByText(term: string, limit: number): Promise<ArticleSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const rows = await this.articles
      .createQueryBuilder('article')
      // `toArticleSearchRow` reads only slug/title/dek — no author/issue
      // hydration and no `blocks`/`body`/`contentNotes`.
      .select(['article.slug', 'article.title', 'article.dek'])
      .where('article.published_at <= :now', { now: new Date() })
      .andWhere(
        '(article.title ILIKE :pattern OR article.dek ILIKE :pattern)',
        { pattern },
      )
      .orderBy('article.published_at', 'DESC', 'NULLS LAST')
      .take(limit)
      .getMany();
    return rows.map(toArticleSearchRow);
  }

  async getArticleBySlug(slug: string): Promise<ArticleResponse> {
    const article = await this.articles.findOne({ where: { slug } });
    // 404 an unknown slug and an unpublished/future-dated one alike — hide its
    // existence rather than surfacing a distinct "not visible yet" response
    // (mirrors `ContentPagesService.getBySlug`).
    if (!article || !article.publishedAt || article.publishedAt > new Date()) {
      throw new NotFoundException('Article not found');
    }
    const author = await this.loadAuthorOr404(article.authorId);
    const issueNumber = await this.issueNumberFor(article.issueId);
    return toArticleResponse(article, author, issueNumber);
  }

  async listAuthors(): Promise<AuthorResponse[]> {
    const rows = await this.authors.find({ order: { name: 'ASC' } });
    return rows.map(toAuthorResponse);
  }

  async getAuthorBySlug(slug: string): Promise<AuthorResponse> {
    const author = await this.authors.findOne({ where: { slug } });
    if (!author) {
      throw new NotFoundException('Author not found');
    }
    return toAuthorResponse(author);
  }

  // --- decks ---

  async listPublishedDecks(
    query: ListDecksInput,
  ): Promise<Paginated<DeckListItemResponse>> {
    const page = normalizePage(query.page);
    const qb = this.decks
      .createQueryBuilder('deck')
      // Same NULL-excluding gate as `listArticles` — a draft (`published_at`
      // null) or future-dated deck never surfaces here.
      .andWhere('deck.published_at <= :now', { now: new Date() });

    if (query.tag) {
      qb.andWhere(':tag = ANY(deck.tags)', { tag: query.tag });
    }

    qb.orderBy('deck.published_at', 'DESC').addOrderBy(
      'deck.created_at',
      'DESC',
    );

    return paginate(qb, page, (rows) => rows.map(toDeckListItem));
  }

  async getPublishedDeckBySlug(slug: string): Promise<DeckResponse> {
    const deck = await this.decks.findOne({ where: { slug } });
    // 404 an unknown slug and an unpublished/future-dated one alike, mirroring
    // `getArticleBySlug` / `ContentPagesService.getBySlug`.
    if (!deck || !deck.publishedAt || deck.publishedAt > new Date()) {
      throw new NotFoundException('Deck not found');
    }
    return toDeckResponse(deck);
  }

  // Admin/moderator listing — every deck, drafts included, newest edit first.
  async listAllDecks(): Promise<DeckListItemResponse[]> {
    const rows = await this.decks.find({ order: { updatedAt: 'DESC' } });
    return rows.map(toDeckListItem);
  }

  // Admin/moderator single-deck load by id (drafts included) — the sub-
  // project 3 authoring UI edits a deck this way, not by slug.
  async getDeckById(id: string): Promise<DeckResponse> {
    const deck = await this.decks.findOne({ where: { id } });
    if (!deck) {
      throw new NotFoundException('Deck not found');
    }
    return toDeckResponse(deck);
  }

  async createDeck(dto: CreateDeckDto): Promise<DeckResponse> {
    const slides = validateDeckSlides(dto.slides);

    const existing = await this.decks.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException('A deck with this slug already exists');
    }

    const deck = this.decks.create({
      ...dto,
      slides,
      role: dto.role ?? null,
      publishedAt: null,
      kicker: dto.kicker ?? '',
      section: dto.section ?? '',
      byline: dto.byline ?? '',
      readTime: dto.readTime ?? '',
      cover: dto.cover ?? '',
      coverDesc: dto.coverDesc ?? '',
    });
    await this.decks.save(deck);
    return toDeckResponse(deck);
  }

  async updateDeck(id: string, dto: UpdateDeckDto): Promise<DeckResponse> {
    const deck = await this.decks.findOne({ where: { id } });
    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    if (dto.slides !== undefined) {
      deck.slides = validateDeckSlides(dto.slides);
    }

    if (dto.published !== undefined) {
      // Re-publishing an already-published deck keeps its original
      // `publishedAt` (first-publish date); only a null -> true transition
      // stamps "now". Unpublishing always clears it.
      deck.publishedAt = dto.published
        ? (deck.publishedAt ?? new Date())
        : null;
    }

    Object.assign(deck, {
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.kicker !== undefined ? { kicker: dto.kicker } : {}),
      ...(dto.section !== undefined ? { section: dto.section } : {}),
      ...(dto.byline !== undefined ? { byline: dto.byline } : {}),
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(dto.authorBio !== undefined ? { authorBio: dto.authorBio } : {}),
      ...(dto.cover !== undefined ? { cover: dto.cover } : {}),
      ...(dto.coverDesc !== undefined ? { coverDesc: dto.coverDesc } : {}),
      ...(dto.readTime !== undefined ? { readTime: dto.readTime } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.related !== undefined ? { related: dto.related } : {}),
    });

    await this.decks.save(deck);
    return toDeckResponse(deck);
  }

  async deleteDeck(id: string): Promise<void> {
    const res = await this.decks.delete(id);
    if (res.affected === 0) {
      throw new NotFoundException('Deck not found');
    }
  }

  // --- internals ---

  // One batched author lookup + one batched issue lookup per page, instead
  // of N+1 per row (mirrors `CommunitiesService.statsForMany`).
  private async toListItems(
    rows: MagazineArticle[],
  ): Promise<ArticleListItem[]> {
    if (!rows.length) return [];

    const authorIds = [...new Set(rows.map((a) => a.authorId))];
    const issueIds = [
      ...new Set(
        rows.map((a) => a.issueId).filter((id): id is string => id !== null),
      ),
    ];

    const [authorRows, issueRows] = await Promise.all([
      this.authors.find({ where: { id: In(authorIds) } }),
      issueIds.length
        ? this.issues.find({ where: { id: In(issueIds) } })
        : Promise.resolve([]),
    ]);
    const authorsById = new Map(authorRows.map((a) => [a.id, a]));
    const issueNumberById = new Map(issueRows.map((i) => [i.id, i.number]));

    return rows
      .map((article) => {
        const author = authorsById.get(article.authorId);
        if (!author) return null;
        const issueNumber = article.issueId
          ? (issueNumberById.get(article.issueId) ?? null)
          : null;
        return toArticleListItem(article, author, issueNumber);
      })
      .filter((item): item is ArticleListItem => item !== null);
  }

  private async loadAuthorOr404(authorId: string): Promise<MagazineAuthor> {
    const author = await this.authors.findOne({ where: { id: authorId } });
    if (!author) {
      // Data-integrity bug (FK should prevent this), not a legitimate empty
      // state — mirrors `CommunitiesService.memberRefFor`.
      throw new NotFoundException('Author not found');
    }
    return author;
  }

  private async issueNumberFor(issueId: string | null): Promise<string | null> {
    if (!issueId) return null;
    const issue = await this.issues.findOne({ where: { id: issueId } });
    return issue?.number ?? null;
  }
}
