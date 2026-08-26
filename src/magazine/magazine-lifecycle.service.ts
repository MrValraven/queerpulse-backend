import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { CreateArticleTranslationDto } from './dto/create-article-translation.dto';
import { SetArticleLifecycleDto } from './dto/set-article-lifecycle.dto';
import {
  ArticleLifecycle,
  DEFAULT_ARTICLE_LOCALE,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import {
  ArticleLifecycleRecord,
  ArticleTranslationRecord,
  LifecycleCounts,
  LifecycleDeskResponse,
  toArticleLifecycleRecord,
} from './magazine-lifecycle-response';

/**
 * How far ahead the review queue looks by default. Thirty days is one
 * editorial cycle: far enough that a due re-review lands on the desk before
 * the date rather than after it, near enough that the queue is a to-do list
 * instead of a calendar.
 */
const DEFAULT_REVIEW_HORIZON_DAYS = 30;

/** Hard ceiling on the horizon, so `?withinDays=100000` cannot ask for the
 *  whole review schedule as one unpaginated read. */
const MAX_REVIEW_HORIZON_DAYS = 365;

/**
 * CON-16 — the write and desk-read side of the content lifecycle.
 *
 * Deliberately its own service rather than more methods on
 * `MagazinePieceService`. That class runs the COMMISSION: pitch, brief,
 * stages, money, publish. Lifecycle picks up after publication and never
 * touches any of it — a piece can be archived years after its editor left,
 * without reopening its desk record. Keeping the two apart also keeps this
 * one small enough to read.
 */
@Injectable()
export class MagazineLifecycleService {
  constructor(
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineAuthor)
    private readonly authors: Repository<MagazineAuthor>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    @InjectRepository(MagazinePieceEvent)
    private readonly pieceEvents: Repository<MagazinePieceEvent>,
  ) {}

  /**
   * The lifecycle desk: what the archive is promising, and what it owes.
   *
   * THREE queries, never one per row: the due queue, the flagged set, and one
   * grouped count. The two lists are then hydrated together, so a superseded
   * piece's replacement and a translation's original are resolved in a single
   * batched lookup each.
   */
  async getDesk(withinDays?: number): Promise<LifecycleDeskResponse> {
    const horizonDays = Math.min(
      MAX_REVIEW_HORIZON_DAYS,
      Math.max(0, withinDays ?? DEFAULT_REVIEW_HORIZON_DAYS),
    );
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
    const horizonIsoDate = horizon.toISOString().slice(0, 10);

    const [dueRows, flaggedRows, countRows] = await Promise.all([
      // Oldest promise first: the piece the desk has kept a reader waiting on
      // longest is the one to look at first.
      this.articles
        .createQueryBuilder('article')
        .where('article.review_due_on IS NOT NULL')
        .andWhere('article.review_due_on <= :horizon', {
          horizon: horizonIsoDate,
        })
        .orderBy('article.reviewDueOn', 'ASC')
        .limit(DEFAULT_LIST_LIMIT)
        .getMany(),
      // Everything a reader currently sees a banner on, most recently changed
      // first.
      this.articles.find({
        where: { lifecycle: Not('live') },
        order: { lifecycleChangedAt: 'DESC' },
        take: DEFAULT_LIST_LIMIT,
      }),
      this.articles
        .createQueryBuilder('article')
        .select('article.lifecycle', 'lifecycle')
        .addSelect('COUNT(*)', 'total')
        .groupBy('article.lifecycle')
        .getRawMany<{ lifecycle: ArticleLifecycle; total: string }>(),
    ]);

    const overdue = await this.articles
      .createQueryBuilder('article')
      .where('article.review_due_on IS NOT NULL')
      .andWhere('article.review_due_on < CURRENT_DATE')
      .getCount();

    const [dueForReview, flagged] = await Promise.all([
      this.toRecords(dueRows),
      this.toRecords(flaggedRows),
    ]);

    return {
      dueForReview,
      flagged,
      counts: this.toCounts(countRows, overdue),
    };
  }

  private toCounts(
    rows: { lifecycle: ArticleLifecycle; total: string }[],
    overdue: number,
  ): LifecycleCounts {
    const totalFor = (state: ArticleLifecycle) =>
      Number(rows.find((row) => row.lifecycle === state)?.total ?? 0);
    return {
      live: totalFor('live'),
      underReview: totalFor('under_review'),
      archived: totalFor('archived'),
      superseded: totalFor('superseded'),
      overdue,
    };
  }

  /**
   * Hydrates a page of articles into desk records: their piece ids, their
   * replacement pieces and their originals. THREE batched queries for the
   * whole page rather than three per row.
   */
  private async toRecords(
    rows: MagazineArticle[],
  ): Promise<ArticleLifecycleRecord[]> {
    if (!rows.length) return [];
    const today = new Date();

    const relatedIds = [
      ...new Set(
        rows.flatMap((article) =>
          [
            article.supersededByArticleId,
            article.translationOfArticleId,
          ].filter((id): id is string => id !== null && id !== undefined),
        ),
      ),
    ];

    const [pieceRows, relatedRows] = await Promise.all([
      this.pieces.find({
        where: { articleId: In(rows.map((article) => article.id)) },
        select: { id: true, articleId: true },
      }),
      relatedIds.length
        ? this.articles.find({
            where: { id: In(relatedIds) },
            select: { id: true, slug: true, title: true },
          })
        : Promise.resolve([]),
    ]);

    const pieceIdByArticleId = new Map(
      pieceRows.map((piece) => [piece.articleId, piece.id]),
    );
    const relatedById = new Map(
      relatedRows.map((article) => [article.id, article]),
    );

    return rows.map((article) =>
      toArticleLifecycleRecord(
        article,
        pieceIdByArticleId.get(article.id) ?? null,
        article.supersededByArticleId
          ? (relatedById.get(article.supersededByArticleId) ?? null)
          : null,
        article.translationOfArticleId
          ? (relatedById.get(article.translationOfArticleId) ?? null)
          : null,
        today,
      ),
    );
  }

  /**
   * Sets where a piece stands, and when the desk will look at it again.
   *
   * `lifecycleChangedAt` is stamped only when the state actually MOVES, so
   * rewriting the banner note or pushing the review date out does not reset
   * the reader-facing date to today and quietly claim a fresh review that
   * never happened.
   *
   * Returning to `live` clears the note, the date and any supersession: the
   * piece is simply current again, and a reader should see the page, not a
   * banner explaining that it used to have one.
   */
  async setLifecycle(
    pieceId: string,
    dto: SetArticleLifecycleDto,
    actorId: string,
  ): Promise<ArticleLifecycleRecord> {
    const piece = await this.pieces.findOne({ where: { id: pieceId } });
    if (!piece) {
      throw new NotFoundException('Piece not found');
    }
    if (!piece.articleId) {
      throw new BadRequestException(
        'This piece has no article yet, so there is nothing to set a lifecycle on.',
      );
    }
    const article = await this.loadArticleOr404(piece.articleId);

    const previousState = article.lifecycle ?? 'live';
    const nextState = dto.lifecycle ?? previousState;

    // Resolve the replacement BEFORE mutating anything, so a bad slug leaves
    // the row untouched instead of half-applied.
    let supersededBy: MagazineArticle | null = null;
    if (dto.supersededBySlug) {
      supersededBy = await this.articles.findOne({
        where: { slug: dto.supersededBySlug },
      });
      if (!supersededBy) {
        throw new NotFoundException(
          'No article with that slug to supersede this one.',
        );
      }
      if (supersededBy.id === article.id) {
        throw new BadRequestException('A piece cannot supersede itself.');
      }
    }

    const nextSupersededById =
      dto.supersededBySlug === null
        ? null
        : supersededBy
          ? supersededBy.id
          : article.supersededByArticleId;

    if (nextState === 'superseded' && !nextSupersededById) {
      throw new BadRequestException(
        'Marking a piece superseded needs the piece that replaces it.',
      );
    }

    if (nextState === 'live') {
      article.lifecycle = 'live';
      article.lifecycleNote = '';
      article.lifecycleChangedAt = null;
      article.supersededByArticleId = null;
    } else {
      article.lifecycle = nextState;
      if (dto.note !== undefined) article.lifecycleNote = dto.note;
      if (nextState !== previousState) {
        article.lifecycleChangedAt = new Date();
      }
      article.supersededByArticleId =
        nextState === 'superseded' ? nextSupersededById : null;
    }

    if (dto.reviewDueOn !== undefined) {
      article.reviewDueOn = dto.reviewDueOn
        ? dto.reviewDueOn.slice(0, 10)
        : null;
    }

    await this.articles.save(article);

    if (nextState !== previousState) {
      // Its own audit row on the piece timeline, so the desk keeps a record of
      // who retired a piece and when, next to who commissioned and published
      // it. `detail` names both ends of the move rather than only the
      // destination.
      await this.recordEvent(
        piece.id,
        actorId,
        'lifecycle_changed',
        `${previousState} -> ${nextState}`,
      );
    }

    const [record] = await this.toRecords([article]);
    return record!;
  }

  /**
   * Opens a translation of a published piece as its own desk record.
   *
   * The new article starts as a COPY of the original's blocks, standfirst,
   * dek and tags rather than as a blank page: a translator works over the
   * structure the writer built, paragraph by paragraph, and handing them an
   * empty editor means rebuilding the piece's shape before translating a
   * word of it. `publishedAt` starts null — the translation ships when it is
   * finished, which is rarely the day the original does.
   *
   * The byline stays the ORIGINAL writer's. The translator is credited
   * separately (`translatorAuthorId`), because both people wrote this.
   */
  async createTranslation(
    pieceId: string,
    dto: CreateArticleTranslationDto,
    actorId: string,
  ): Promise<ArticleTranslationRecord> {
    const piece = await this.pieces.findOne({ where: { id: pieceId } });
    if (!piece) {
      throw new NotFoundException('Piece not found');
    }
    if (!piece.articleId) {
      throw new BadRequestException(
        'This piece has no article yet, so there is nothing to translate.',
      );
    }
    const original = await this.loadArticleOr404(piece.articleId);

    if (original.translationOfArticleId) {
      throw new BadRequestException(
        'Translate from the original piece rather than from another translation.',
      );
    }
    if ((original.locale ?? DEFAULT_ARTICLE_LOCALE) === dto.locale) {
      throw new BadRequestException(
        'This piece is already written in that language.',
      );
    }

    const existing = await this.articles.findOne({
      where: { translationOfArticleId: original.id, locale: dto.locale },
    });
    if (existing) {
      throw new ConflictException(
        'This piece already has a translation in that language.',
      );
    }

    const translatorAuthorId = dto.translatorByline
      ? await this.resolveTranslatorAuthorId(
          dto.translatorByline,
          dto.translatorUserId ?? null,
        )
      : null;

    const slug = await allocateUniqueSlug(
      slugify(dto.slug ?? `${original.slug}-${dto.locale}`, 'translation'),
      async (candidate) =>
        (await this.articles.findOne({ where: { slug: candidate } })) !== null,
    );

    const translation = this.articles.create({
      slug,
      title: original.title,
      dek: original.dek,
      body: original.body,
      standfirst: original.standfirst,
      kicker: original.kicker,
      section: original.section,
      role: original.role,
      contentNotes: original.contentNotes,
      blocks: original.blocks,
      // The writer's credit travels with the piece; the translator gets their
      // own line rather than displacing it.
      authorId: original.authorId,
      issueId: original.issueId,
      tags: original.tags,
      readMinutes: original.readMinutes,
      publishedAt: null,
      locale: dto.locale,
      translationOfArticleId: original.id,
      translatorAuthorId,
      // A fresh piece of work, current as of today. It does NOT inherit the
      // original's lifecycle: translating a piece the desk has archived is a
      // legitimate thing to do, and the translation's own standing is its own
      // editorial decision.
      lifecycle: 'live',
      version: 0,
    });
    await this.articles.save(translation);

    const translationPiece = this.pieces.create({
      format: piece.format,
      title: original.title,
      section: original.section,
      kind: piece.kind,
      stage: 'drafting',
      // The commissioning editor carries over so the translation lands on a
      // real desk rather than nobody's.
      editorId: piece.editorId,
      writerId: dto.translatorUserId ?? null,
      byline: piece.byline,
      issueId: original.issueId,
      articleId: translation.id,
      art: 'none',
    });
    await this.pieces.save(translationPiece);

    await this.recordEvent(
      translationPiece.id,
      actorId,
      'translation_started',
      `${original.locale ?? DEFAULT_ARTICLE_LOCALE} -> ${dto.locale}`,
    );
    // Also recorded against the ORIGINAL's timeline: an editor looking at the
    // English piece should be able to see that a Portuguese version was
    // opened, without knowing to go looking for it.
    await this.recordEvent(
      piece.id,
      actorId,
      'translation_opened',
      `${dto.locale}: ${slug}`,
    );

    const translator = translatorAuthorId
      ? await this.authors.findOne({ where: { id: translatorAuthorId } })
      : null;

    return {
      articleId: translation.id,
      pieceId: translationPiece.id,
      slug: translation.slug,
      title: translation.title,
      locale: dto.locale,
      publishedAt: null,
      translatorSlug: translator?.slug ?? null,
    };
  }

  /** Every translation family member of a piece's article, for the desk's
   *  languages panel. Ordered by locale so the list is stable. */
  async listTranslations(pieceId: string): Promise<ArticleTranslationRecord[]> {
    const piece = await this.pieces.findOne({ where: { id: pieceId } });
    if (!piece) {
      throw new NotFoundException('Piece not found');
    }
    if (!piece.articleId) return [];
    const article = await this.loadArticleOr404(piece.articleId);
    const originalId = article.translationOfArticleId ?? article.id;

    const family = await this.articles.find({
      where: [{ id: originalId }, { translationOfArticleId: originalId }],
      order: { locale: 'ASC' },
    });

    const translatorIds = [
      ...new Set(
        family
          .map((row) => row.translatorAuthorId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    const [pieceRows, translatorRows] = await Promise.all([
      this.pieces.find({
        where: { articleId: In(family.map((row) => row.id)) },
        select: { id: true, articleId: true },
      }),
      translatorIds.length
        ? this.authors.find({ where: { id: In(translatorIds) } })
        : Promise.resolve([]),
    ]);
    const pieceIdByArticleId = new Map(
      pieceRows.map((row) => [row.articleId, row.id]),
    );
    const translatorById = new Map(
      translatorRows.map((author) => [author.id, author]),
    );

    return family.map((row) => ({
      articleId: row.id,
      pieceId: pieceIdByArticleId.get(row.id) ?? null,
      slug: row.slug,
      title: row.title,
      locale: row.locale ?? DEFAULT_ARTICLE_LOCALE,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      translatorSlug: row.translatorAuthorId
        ? (translatorById.get(row.translatorAuthorId)?.slug ?? null)
        : null,
    }));
  }

  /**
   * Find-or-create the translator's byline row, keyed by the slugified name
   * exactly as `MagazinePieceService.resolveAuthorId` keys a writer's, so the
   * same person translating two pieces resolves to one author page.
   *
   * `userId` is only attached to a byline that does not already have one, and
   * only when no OTHER byline already claims that account: `user_id` is
   * partial-unique, so writing a second would fail the index rather than
   * quietly link the wrong person.
   */
  private async resolveTranslatorAuthorId(
    byline: string,
    userId: string | null,
  ): Promise<string> {
    const slug = slugify(byline, 'translator');
    let author = await this.authors.findOne({ where: { slug } });
    if (!author) {
      author = this.authors.create({
        slug,
        name: byline.trim(),
        bio: null,
        avatarUrl: null,
        userId: null,
      });
      await this.authors.save(author);
    }

    if (userId && !author.userId) {
      const alreadyLinked = await this.authors.findOne({
        where: { userId, id: Not(author.id) },
      });
      if (!alreadyLinked) {
        author.userId = userId;
        await this.authors.save(author);
      }
    }

    return author.id;
  }

  private async loadArticleOr404(articleId: string): Promise<MagazineArticle> {
    const article = await this.articles.findOne({ where: { id: articleId } });
    if (!article) {
      throw new NotFoundException('Article not found');
    }
    return article;
  }

  private async recordEvent(
    pieceId: string,
    actorId: string | null,
    action: string,
    detail: string | null = null,
  ): Promise<void> {
    const event = this.pieceEvents.create({
      pieceId,
      actorId,
      action,
      detail,
    });
    await this.pieceEvents.save(event);
  }
}
