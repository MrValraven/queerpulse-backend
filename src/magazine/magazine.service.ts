import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import {
  normalizePage,
  PAGE_SIZE,
  paginate,
  Paginated,
} from '../common/pagination';
import { MediaCropService } from '../media-crops/media-crops.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { Profile } from '../users/entities/profile.entity';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { validateDeckSlides } from './deck-slides.validation';
import { CreateDeckDto } from './dto/create-deck.dto';
import { UpdateDeckDto } from './dto/update-deck.dto';
import {
  DEFAULT_ARTICLE_LOCALE,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { toArticleLocale } from './magazine-locale';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { DeckSlide, MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import { toPrefixTsQuery } from './magazine-search-query';
import {
  ArticleListItem,
  ArticleResponse,
  ArticleResponseExtras,
  ArticleSearchRow,
  AuthorMemberLink,
  AuthorResponse,
  DeckListItemResponse,
  DeckResponse,
  IssueResponse,
  SectionResponse,
  toArticleListItem,
  toArticleResponse,
  toArticleSearchRow,
  toAuthorResponse,
  toDeckListItem,
  toDeckResponse,
  toIssueResponse,
  toSectionResponse,
} from './magazine-response';

export interface ListArticlesInput {
  issue?: string;
  tag?: string;
  author?: string;
  section?: string;
  /** CON-12 — free-text search across the magazine's own archive. */
  q?: string;
  /**
   * CON-16 — the reader's language. When a piece in this list has a
   * translation in this locale, the translated row is served in its place;
   * pieces with no translation stay in the language they were written in.
   * An issue is often only partly translated, and each card carries its own
   * `locale` so the reader can see which is which.
   */
  lang?: string;
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
    @InjectRepository(MagazineSection)
    private readonly sections: Repository<MagazineSection>,
    // CON-02 — published corrections reach the reader from the article read.
    // The rows hang off the STAFF piece record (`magazine_piece.article_id`),
    // so the query below joins back through it.
    @InjectRepository(MagazineCorrection)
    private readonly corrections: Repository<MagazineCorrection>,
    // Byline -> member link (CON-11): resolves `MagazineAuthor.userId` to the
    // profile slug/name/avatar the author reads expose.
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    // Batched crop lookup (`MediaCropService.getMany`) for an issue's
    // `coverUrl` sibling `crop`.
    private readonly mediaCropService: MediaCropService,
  ) {}

  // CNT-20 — the section/topic taxonomy (`MagazineSection`, seeded rows:
  // Cover, Features, Reported, Interview, Essays, Service, Photo, Review,
  // Column, "Last word"), previously only read internally
  // (`magazine-piece.service.ts` issue-plan gap counts), now exposed for the
  // public section browse page.
  async listSections(): Promise<SectionResponse[]> {
    const rows = await this.sections.find({ order: { orderIndex: 'ASC' } });
    return rows.map(toSectionResponse);
  }

  /**
   * Today as `YYYY-MM-DD`, the ceiling both public issue reads compare
   * `magazine_issue.published_on` against (CON-18). The column is a Postgres
   * `date`, so a plain ISO day string is the right operand — the article
   * reads use a timestamp against `published_at` for the same reason.
   */
  private todayIsoDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * CON-18 — the public archive is PUBLISHED issues only. `published_on`
   * is NULL while an issue is merely opened at the desk and a future date
   * while it is scheduled, and either way its number, title, dek and cover
   * are embargoed: an unshipped cover and theme are exactly what an
   * editorial team holds back until launch.
   *
   * NULL rows drop out on their own because `NULL <= :today` is unknown
   * rather than true, the same way `listArticles` gates on `published_at`.
   * The desk keeps its unfiltered view through
   * `GET /magazine/admin/issues` (`MagazinePieceService.listIssuesForDesk`),
   * which is staff-guarded and carries the `id`/`theme`/slot-fill this read
   * deliberately omits.
   */
  async listIssues(): Promise<IssueResponse[]> {
    // Project only what `toIssueResponse` reads — the full row also carries
    // the `runOrder`/`digest`/`coverlines` jsonb (issue-production data),
    // none of which this public read ever maps.
    const rows = await this.issues.find({
      where: { publishedOn: LessThanOrEqual(this.todayIsoDate()) },
      select: {
        number: true,
        title: true,
        dek: true,
        publishedOn: true,
        coverUrl: true,
      },
      order: { number: 'DESC' },
    });
    // ONE batched crop lookup for every issue cover on the page — never a
    // per-issue query.
    const crops = await this.mediaCropService.getMany(
      rows.flatMap((row) => (row.coverUrl ? [row.coverUrl] : [])),
    );
    return rows.map((row) => toIssueResponse(row, crops));
  }

  /**
   * Same embargo gate as `listIssues` (CON-18): an unshipped or scheduled
   * issue 404s here rather than handing a member the cover and dek by
   * guessing the next number. The desk reads the production record through
   * `GET /magazine/admin/issues/:number` instead.
   */
  async getIssueByNumber(number: string): Promise<IssueResponse> {
    const issue = await this.issues.findOne({
      where: { number, publishedOn: LessThanOrEqual(this.todayIsoDate()) },
    });
    if (!issue) {
      throw new NotFoundException('Issue not found');
    }
    const crops = await this.mediaCropService.getMany(
      issue.coverUrl ? [issue.coverUrl] : [],
    );
    return toIssueResponse(issue, crops);
  }

  async listArticles(
    query: ListArticlesInput,
  ): Promise<Paginated<ArticleListItem>> {
    const page = normalizePage(query.page);
    // CON-12. `null` means the reader typed something with nothing searchable
    // in it (only punctuation, say). That is a search with zero hits, never a
    // search with no filter — falling through would answer "!!!" with the
    // whole magazine.
    const searchQuery = query.q ? toPrefixTsQuery(query.q) : null;
    if (query.q && !searchQuery) {
      return { items: [], total: 0, page, pageSize: PAGE_SIZE };
    }
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
        // CON-16 — every card states where the piece stands and what language
        // it is in. Two small scalars; without them an archived 2024 guide
        // renders in a list identically to this week's piece.
        'article.lifecycle',
        'article.locale',
        'article.translationOfArticleId',
        // CON-04 — the lead art, so a live card shows the piece's own
        // photograph instead of a tinted placeholder.
        'article.heroImageKey',
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
    if (query.section) {
      // Exact string match against the free-text `article.section` column —
      // see the `ListArticlesQuery.section` comment for why this doesn't
      // validate against the seeded `MagazineSection` taxonomy.
      qb.andWhere('article.section = :section', { section: query.section });
    }

    // CON-16 — a browse list shows each PIECE once. A translation is a
    // separate published row with its own slug, so without this filter every
    // translated piece would appear twice in the archive, in an issue's
    // contents and on a tag page, once per language.
    //
    // Search is the deliberate exception (hence the `!searchQuery` guard):
    // `?q=` is not a browse list, it is "find the text I typed", and a
    // Portuguese query can only ever match Portuguese text. Filtering
    // translations out of search would make the Portuguese half of the
    // magazine unfindable in Portuguese.
    if (!searchQuery) {
      qb.andWhere('article.translation_of_article_id IS NULL');
    }

    if (searchQuery) {
      // CON-12 — matched against the STORED generated `search_vector` column
      // (title/dek/standfirst/tags + both body representations), served by
      // `IDX_magazine_article_search_vector`, a GIN index. `@@` and
      // `ts_rank_cd` have no query-builder equivalent, so this is raw SQL
      // with the tsquery bound as a parameter.
      qb.andWhere(
        `article.search_vector @@ to_tsquery('english', :searchQuery)`,
        { searchQuery },
      );
      // Relevance first, recency only as the tiebreaker: a search that
      // answered in publish order would bury the piece actually about the
      // term under whatever ran most recently. `ts_rank_cd` (cover density)
      // rewards hits that sit close together, and the column's `setweight`
      // A/B/D grading puts a headline match above a body mention.
      qb.orderBy(
        `ts_rank_cd(article.search_vector, to_tsquery('english', :searchQuery))`,
        'DESC',
      ).addOrderBy('article.publishedAt', 'DESC', 'NULLS LAST');

      // `offset`/`limit`, NOT `paginate`'s `skip`/`take`: with `?q=` combined
      // with `?author=`/`?issue=` the join would send skip/take through
      // TypeORM's distinct-id pagination pass, which resolves every ORDER BY
      // key through `findAliasByName` and throws on a raw expression like the
      // `ts_rank_cd(...)` above. Both joins here are many-to-one, so no row
      // multiplication makes the plain offset/limit wrong.
      const [rows, total] = await qb
        .offset((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .getManyAndCount();
      return {
        items: await this.toListItems(rows),
        total,
        page,
        pageSize: PAGE_SIZE,
      };
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

    return paginate(qb, page, async (rows) =>
      this.toListItems(await this.preferTranslations(rows, query.lang)),
    );
  }

  /**
   * CON-16 — swap each row for its translation in the reader's language,
   * where one has been published.
   *
   * Deliberately a SUBSTITUTION, not a filter. An issue is almost never
   * translated all at once: the essay goes into Portuguese first, the
   * reported piece a week later, the column maybe never. Filtering to
   * `locale = 'pt'` would hand a Portuguese reader a near-empty issue and
   * hide journalism from them; substituting gives them the whole issue, in
   * Portuguese wherever it exists and in English where it does not. Each row
   * carries its own `locale`, so the cards can say which is which rather
   * than leaving the reader to discover it by clicking.
   *
   * ONE extra query per page, or none at all when the reader is on the
   * default locale (every original is already in it).
   */
  private async preferTranslations(
    rows: MagazineArticle[],
    lang?: string,
  ): Promise<MagazineArticle[]> {
    const locale = toArticleLocale(lang);
    if (!locale || locale === DEFAULT_ARTICLE_LOCALE || !rows.length) {
      return rows;
    }
    const translations = await this.articles
      .createQueryBuilder('article')
      // Same projection as the list query above, so a substituted row maps
      // through `toListItems` identically to an original.
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
        'article.lifecycle',
        'article.locale',
        'article.translationOfArticleId',
        'article.heroImageKey',
      ])
      .where('article.translation_of_article_id IN (:...originalIds)', {
        originalIds: rows.map((article) => article.id),
      })
      .andWhere('article.locale = :locale', { locale })
      // A translation still in draft is not something a reader can open, so
      // it never displaces the original they CAN read.
      .andWhere('article.published_at <= :now', { now: new Date() })
      .getMany();

    const byOriginalId = new Map(
      translations.map((article) => [article.translationOfArticleId, article]),
    );
    return rows.map((article) => byOriginalId.get(article.id) ?? article);
  }

  // Cross-entity global search (SearchService) — published articles only
  // (same `published_at <= now` gate as `listArticles`, so unpublished/
  // future-dated pieces never surface). No author or issue hydration — the
  // search row needs neither.
  //
  // CON-12: this used to be `title ILIKE '%term%' OR dek ILIKE '%term%'`, so
  // the magazine answered the global search box on headlines alone. A piece
  // whose subject was named in its third paragraph, or carried as a tag, was
  // invisible. It now runs the same `search_vector` index the magazine's own
  // search uses, which covers the standfirst, the tags, and both body
  // representations, and it ranks by relevance instead of publish date.
  async searchByText(term: string, limit: number): Promise<ArticleSearchRow[]> {
    const searchQuery = toPrefixTsQuery(term);
    // Nothing searchable in the term: zero magazine hits, and no query run.
    if (!searchQuery) {
      return [];
    }
    const rows = await this.articles
      .createQueryBuilder('article')
      // `toArticleSearchRow` reads only slug/title/dek — no author/issue
      // hydration and no `blocks`/`body`/`contentNotes`.
      .select(['article.slug', 'article.title', 'article.dek'])
      .where('article.published_at <= :now', { now: new Date() })
      .andWhere(
        `article.search_vector @@ to_tsquery('english', :searchQuery)`,
        { searchQuery },
      )
      .orderBy(
        `ts_rank_cd(article.search_vector, to_tsquery('english', :searchQuery))`,
        'DESC',
      )
      .addOrderBy('article.publishedAt', 'DESC', 'NULLS LAST')
      // `limit`, not `take`: `take` is the paginated-entity form, and the raw
      // `ts_rank_cd(...)` ORDER BY above is not something TypeORM's distinct-id
      // pass can resolve. There are no joins here to need it.
      .limit(limit)
      .getMany();
    return rows.map(toArticleSearchRow);
  }

  /**
   * CON-16 — `lang` is the reader's chosen language. When the addressed piece
   * has a PUBLISHED translation in it, that translation is served instead,
   * and the response states its own `slug`, so the caller can correct the URL
   * (the frontend replaces `?id=` with the served slug). A translation is a
   * first-class article at its own address; the language switch resolves to
   * that address rather than serving one piece's text under another's URL.
   *
   * When there is no translation in the chosen language the piece is served
   * as written, and `translations` tells the reader exactly which languages
   * it does exist in. Asking for a language the magazine does not have is
   * never an error.
   */
  async getArticleBySlug(
    slug: string,
    lang?: string,
  ): Promise<ArticleResponse> {
    const addressed = await this.articles.findOne({ where: { slug } });
    // 404 an unknown slug and an unpublished/future-dated one alike — hide its
    // existence rather than surfacing a distinct "not visible yet" response
    // (mirrors `ContentPagesService.getBySlug`).
    if (
      !addressed ||
      !addressed.publishedAt ||
      addressed.publishedAt > new Date()
    ) {
      throw new NotFoundException('Article not found');
    }

    const article = await this.resolveRequestedLocale(addressed, lang);
    const author = await this.loadAuthorOr404(article.authorId);
    const [issueNumber, corrections, extras] = await Promise.all([
      this.issueNumberFor(article.issueId),
      this.correctionsForArticle(article.id),
      this.articleExtras(article),
    ]);
    return toArticleResponse(article, author, issueNumber, corrections, extras);
  }

  /**
   * The published sibling of `article` in the reader's language, or `article`
   * itself. Works from whichever row the reader landed on: `originalIdOf`
   * below resolves a translation back to its original first, so switching
   * from the Portuguese piece to English finds the source text rather than
   * looking for a translation of a translation.
   */
  private async resolveRequestedLocale(
    article: MagazineArticle,
    lang?: string,
  ): Promise<MagazineArticle> {
    const locale = toArticleLocale(lang);
    if (!locale || locale === (article.locale ?? DEFAULT_ARTICLE_LOCALE)) {
      return article;
    }
    const originalId = article.translationOfArticleId ?? article.id;
    const candidate =
      locale === DEFAULT_ARTICLE_LOCALE && article.translationOfArticleId
        ? await this.articles.findOne({ where: { id: originalId } })
        : await this.articles.findOne({
            where: {
              translationOfArticleId: originalId,
              locale,
            },
          });
    // An unpublished translation is not something the reader can be sent to;
    // they stay on the piece they are already reading.
    if (
      !candidate ||
      !candidate.publishedAt ||
      candidate.publishedAt > new Date()
    ) {
      return article;
    }
    return candidate;
  }

  /**
   * CON-16 — the rows the article read needs beyond the piece itself: the
   * replacement piece for a superseded one, every sibling language for the
   * switcher, the original behind a translation, and the translator's byline.
   *
   * Batched into ONE sibling query plus at most two point lookups, all in
   * parallel. A `live`, untranslated, original piece (which is most of the
   * archive) costs a single sibling query that returns nothing.
   */
  private async articleExtras(
    article: MagazineArticle,
  ): Promise<ArticleResponseExtras> {
    const originalId = article.translationOfArticleId ?? article.id;
    const [supersededBy, siblings, translationOf, translator] =
      await Promise.all([
        article.supersededByArticleId
          ? this.articles.findOne({
              where: { id: article.supersededByArticleId },
            })
          : Promise.resolve(null),
        // Every row in this piece's translation family except the row itself:
        // the original (when the reader is on a translation) and every
        // translation of it.
        this.articles
          .createQueryBuilder('article')
          .where(
            '(article.id = :originalId OR article.translation_of_article_id = :originalId)',
            { originalId },
          )
          .andWhere('article.id != :selfId', { selfId: article.id })
          .getMany(),
        article.translationOfArticleId
          ? this.articles.findOne({ where: { id: originalId } })
          : Promise.resolve(null),
        article.translatorAuthorId
          ? this.authors.findOne({ where: { id: article.translatorAuthorId } })
          : Promise.resolve(null),
      ]);

    // CON-04 — the reframe crop for this piece's lead art, in ONE batched
    // lookup alongside everything else the article read needs. Skipped
    // entirely when the piece carries no art.
    const crops = await this.mediaCropService.getMany(
      article.heroImageKey ? [article.heroImageKey] : [],
    );

    return { supersededBy, siblings, translationOf, translator, crops };
  }

  /**
   * CON-02 — the published corrections against this article, newest first.
   * ONE query: `magazine_correction` joined back to the staff piece record
   * that owns it (`magazine_piece.article_id`). Future-dated notes are held
   * back, mirroring the `published_at <= now` gate on the article itself.
   */
  private async correctionsForArticle(
    articleId: string,
  ): Promise<MagazineCorrection[]> {
    return this.corrections
      .createQueryBuilder('correction')
      .innerJoin(MagazinePiece, 'piece', 'piece.id = correction.piece_id')
      .where('piece.article_id = :articleId', { articleId })
      .andWhere(
        '(correction.published_on IS NULL OR correction.published_on <= CURRENT_DATE)',
      )
      .orderBy('correction.published_on', 'DESC', 'NULLS LAST')
      .addOrderBy('correction.created_at', 'DESC')
      .getMany();
  }

  async listAuthors(): Promise<AuthorResponse[]> {
    const rows = await this.authors.find({ order: { name: 'ASC' } });
    // TWO batched lookups for the whole directory (member links, piece
    // counts), never one pair per card.
    const [links, counts] = await Promise.all([
      this.memberLinksFor(rows),
      this.publishedPieceCountsFor(rows),
    ]);
    return rows.map((author) =>
      toAuthorResponse(
        author,
        author.userId ? (links.get(author.userId) ?? null) : null,
        counts.get(author.id) ?? 0,
      ),
    );
  }

  async getAuthorBySlug(slug: string): Promise<AuthorResponse> {
    const author = await this.authors.findOne({ where: { slug } });
    if (!author) {
      throw new NotFoundException('Author not found');
    }
    return this.toOneAuthorResponse(author);
  }

  /**
   * The byline belonging to a member, addressed by their PROFILE slug — the
   * "Writing" surface on a member profile (CON-11). Returns `null` rather
   * than 404ing: most members have never written for the magazine, which is
   * an empty state, not an error. Consume with `apiGetNullable` on the FE.
   */
  async getAuthorForMemberSlug(
    memberSlug: string,
  ): Promise<AuthorResponse | null> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
      select: {
        userId: true,
        slug: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
    if (!profile) return null;
    return this.getAuthorForUser(profile.userId);
  }

  /** The caller's own byline (`GET /magazine/authors/me`), or `null`. */
  async getAuthorForUser(userId: string): Promise<AuthorResponse | null> {
    const author = await this.authors.findOne({ where: { userId } });
    if (!author) return null;
    return this.toOneAuthorResponse(author);
  }

  /**
   * Staff edit of any byline (`magazine_editor`), plus the optional
   * link/unlink of the member account behind it. `memberSlug: null` unlinks.
   */
  async updateAuthorBySlug(
    slug: string,
    dto: UpdateAuthorDto,
    requesterUserId: string,
  ): Promise<AuthorResponse> {
    const author = await this.authors.findOne({ where: { slug } });
    if (!author) {
      throw new NotFoundException('Author not found');
    }

    if (dto.memberSlug !== undefined) {
      author.userId = await this.resolveLinkTarget(author, dto.memberSlug);
    }
    return this.applyAuthorEdits(author, dto, requesterUserId);
  }

  /**
   * A linked member editing their OWN author bio/portrait. The byline NAME
   * stays editorial (staff-only): it is what is printed on published pieces,
   * so a writer renaming it would silently rewrite past credits.
   */
  async updateOwnAuthor(
    userId: string,
    dto: UpdateAuthorDto,
    requesterUserId: string,
  ): Promise<AuthorResponse> {
    const author = await this.authors.findOne({ where: { userId } });
    if (!author) {
      throw new NotFoundException(
        'You have no magazine byline yet. One is created when your first piece publishes.',
      );
    }
    return this.applyAuthorEdits(
      author,
      { bio: dto.bio, avatarUrl: dto.avatarUrl },
      requesterUserId,
    );
  }

  // --- author internals ---

  private async toOneAuthorResponse(
    author: MagazineAuthor,
  ): Promise<AuthorResponse> {
    const [links, counts] = await Promise.all([
      this.memberLinksFor([author]),
      this.publishedPieceCountsFor([author]),
    ]);
    return toAuthorResponse(
      author,
      author.userId ? (links.get(author.userId) ?? null) : null,
      counts.get(author.id) ?? 0,
    );
  }

  /** ONE profile lookup for every linked byline in the batch. */
  private async memberLinksFor(
    rows: MagazineAuthor[],
  ): Promise<Map<string, AuthorMemberLink>> {
    const userIds = [
      ...new Set(
        rows
          .map((author) => author.userId)
          .filter((userId): userId is string => userId !== null),
      ),
    ];
    if (userIds.length === 0) return new Map();
    const profiles = await this.profiles.find({
      where: { userId: In(userIds) },
      // Project only what `AuthorMemberLink` carries — the full profile row is
      // ~40 columns of member data this public read has no business touching.
      select: {
        userId: true,
        slug: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
    return new Map(
      profiles.map((profile) => [
        profile.userId,
        {
          memberSlug: profile.slug,
          memberName: `${profile.firstName} ${profile.lastName}`.trim(),
          memberAvatarUrl: profile.avatarUrl,
        },
      ]),
    );
  }

  /**
   * Published pieces per byline, in ONE grouped count. Same
   * `published_at <= now` gate as `getArticleBySlug`, so a draft or a
   * future-dated piece never inflates a public tally.
   */
  private async publishedPieceCountsFor(
    rows: MagazineAuthor[],
  ): Promise<Map<string, number>> {
    if (rows.length === 0) return new Map();
    const authorIds = rows.map((author) => author.id);
    const counted = await this.articles
      .createQueryBuilder('article')
      .select('article.author_id', 'authorId')
      .addSelect('COUNT(*)', 'count')
      .where('article.author_id IN (:...authorIds)', { authorIds })
      .andWhere('article.published_at <= :now', { now: new Date() })
      .groupBy('article.author_id')
      .getRawMany<{ authorId: string; count: string }>();
    return new Map(
      counted.map((row) => [row.authorId, Number(row.count) || 0]),
    );
  }

  /**
   * Resolves `memberSlug` to a `userId` for the staff link/unlink, refusing a
   * member who already holds a different byline (the partial unique index
   * would otherwise fail as a 500).
   */
  private async resolveLinkTarget(
    author: MagazineAuthor,
    memberSlug: string | null,
  ): Promise<string | null> {
    if (memberSlug === null) return null;
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
      select: { userId: true, slug: true },
    });
    if (!profile) {
      throw new NotFoundException('No member with that profile slug');
    }
    const alreadyLinked = await this.authors.findOne({
      where: { userId: profile.userId },
    });
    if (alreadyLinked && alreadyLinked.id !== author.id) {
      throw new ConflictException(
        'That member is already linked to another magazine byline',
      );
    }
    return profile.userId;
  }

  private async applyAuthorEdits(
    author: MagazineAuthor,
    dto: UpdateAuthorDto,
    requesterUserId: string,
  ): Promise<AuthorResponse> {
    // Foreign-upload backstop: a byline is edited by any `magazine_editor`
    // and by its own member, so the stored portrait may have been uploaded by
    // somebody else. Allow it only when it is ALREADY the stored value; a new
    // foreign reference is refused. Runs BEFORE any mutation.
    if (dto.avatarUrl !== undefined && dto.avatarUrl !== null) {
      assertNoForeignUploadIntroduced(
        requesterUserId,
        dto.avatarUrl,
        author.avatarUrl ? [author.avatarUrl] : [],
      );
    }

    if (dto.name !== undefined) {
      author.name = dto.name.trim();
    }
    if (dto.bio !== undefined) {
      // Empty text is "no bio", stored as NULL, matching an auto-created row.
      author.bio = dto.bio.trim().length > 0 ? dto.bio.trim() : null;
    }
    if (dto.avatarUrl !== undefined) {
      author.avatarUrl =
        dto.avatarUrl && dto.avatarUrl.trim().length > 0
          ? dto.avatarUrl.trim()
          : null;
    }
    await this.authors.save(author);
    return this.toOneAuthorResponse(author);
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

  /**
   * Every image storage key referenced by a deck: its cover plus each image
   * slide's `src` and each before/after interactive panel's `src`. Blank
   * values are dropped. Used as the `alreadyStored` baseline for the M1
   * foreign-upload backstop.
   */
  private collectDeckImageRefs(
    cover: string | null | undefined,
    slides: readonly DeckSlide[],
  ): string[] {
    const refs: string[] = [];
    if (cover) {
      refs.push(cover);
    }
    for (const slide of slides) {
      if (slide.layout === 'image' && slide.src) {
        refs.push(slide.src);
      }
      if (slide.layout === 'interactive' && slide.kind === 'before-after') {
        if (slide.before?.src) {
          refs.push(slide.before.src);
        }
        if (slide.after?.src) {
          refs.push(slide.after.src);
        }
      }
    }
    return refs;
  }

  async createDeck(
    dto: CreateDeckDto,
    requesterUserId: string,
  ): Promise<DeckResponse> {
    const slides = validateDeckSlides(dto.slides);

    // Foreign-upload backstop (M1): the deck-create handler keeps the
    // interceptor's shared-upload exemption, so a foreign storage key reaches
    // the service. A fresh deck has NO stored baseline, so every referenced
    // image must belong to the creator — any foreign key is a new reference and
    // is refused. Runs BEFORE the slug lookup / insert.
    const noStoredBaseline: string[] = [];
    for (const incomingImageRef of this.collectDeckImageRefs(
      dto.cover,
      slides,
    )) {
      assertNoForeignUploadIntroduced(
        requesterUserId,
        incomingImageRef,
        noStoredBaseline,
      );
    }

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

  async updateDeck(
    id: string,
    dto: UpdateDeckDto,
    requesterUserId: string,
  ): Promise<DeckResponse> {
    const deck = await this.decks.findOne({ where: { id } });
    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    const incomingSlides =
      dto.slides !== undefined ? validateDeckSlides(dto.slides) : undefined;

    // Foreign-upload backstop (M1): the deck-update handler keeps the
    // interceptor's shared-upload exemption (any `magazine_editor` re-saves a
    // deck whose cover/slide images a DIFFERENT editor uploaded), so a foreign
    // key reaches here. Allow it only when it is ALREADY stored on the deck; a
    // new foreign reference is refused. Runs BEFORE any mutation.
    const storedDeckImageRefs = this.collectDeckImageRefs(
      deck.cover,
      deck.slides,
    );
    if (dto.cover !== undefined) {
      assertNoForeignUploadIntroduced(
        requesterUserId,
        dto.cover,
        storedDeckImageRefs,
      );
    }
    if (incomingSlides !== undefined) {
      for (const incomingImageRef of this.collectDeckImageRefs(
        undefined,
        incomingSlides,
      )) {
        assertNoForeignUploadIntroduced(
          requesterUserId,
          incomingImageRef,
          storedDeckImageRefs,
        );
      }
    }

    if (incomingSlides !== undefined) {
      deck.slides = incomingSlides;
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
