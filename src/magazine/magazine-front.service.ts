import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import {
  AuthorSummary,
  IssueResponse,
  toAuthorSummary,
  toIssueResponse,
} from './magazine-response';

/**
 * One slot on the magazine front, resolved from a `runOrder` entry to the
 * published article behind it.
 *
 * Deliberately its own shape rather than `ArticleListItem`: it carries the
 * two things the run order adds and a list row does not have — the desk
 * `section` the piece runs under, and the `blurb` the editor wrote for it on
 * the issue-production page.
 */
export interface MagazineFrontEntry {
  slug: string;
  title: string;
  dek: string;
  kicker: string;
  standfirst: string;
  author: AuthorSummary;
  /** The desk section this piece runs under ("Features", "Last word", …). */
  section: string;
  /** The editor's own line about this piece. `''` when none was written. */
  blurb: string;
  readMinutes: number;
  /**
   * CON-04 — the piece's own lead art (`heroImageKey`), falling back to its
   * social-share image when the desk set only that. `null` when it has
   * neither, in which case the front keeps its tinted placeholder rather than
   * standing in a photograph nobody chose.
   */
  imageUrl: string | null;
  /**
   * The reframe crop saved for `imageUrl`, when a staff editor reframed it.
   * Rendered as a FOCAL POINT: both slots that show it (the full-bleed lead
   * and the rail card's cover strip) have a box aspect that never matches an
   * arbitrary crop, and `ImageSlot`'s exact-frame `crop` prop would distort
   * the art there.
   */
  imageCrop?: CropRect;
  publishedAt: string | null;
}

/** A run of consecutive run-order slots sharing one desk section. */
export interface MagazineFrontSection {
  /** `''` when the piece carries no section — the FE heads that group itself. */
  name: string;
  entries: MagazineFrontEntry[];
}

/** `GET /magazine/front`. */
export interface MagazineFrontResponse {
  /** The issue the front is currently showing, or `null` before any ships. */
  issue: IssueResponse | null;
  /** The piece the editor put first in the run order. */
  lead: MagazineFrontEntry | null;
  /** Everything after the lead, grouped by section in run-order order. */
  sections: MagazineFrontSection[];
}

/**
 * The reader-facing magazine front, arranged by the desk (CON-13).
 *
 * The front used to be `articles.slice(0, 9)` in `published_at DESC` — a
 * reverse-chronological blog roll with no lead story, on a product whose desk
 * can commission, edit, gate and ship a whole issue. The editorial judgement
 * was already recorded and simply never read: `magazine_issue.run_order`
 * (jsonb, `{ pieceId, pages }[]`) is the hand-set running order, and ARRAY
 * ORDER IS THE ORDER. Its first slot is the lead story; consecutive slots
 * sharing a `MagazinePiece.section` are a section rail.
 *
 * Its own service beside `MagazineService`, on the
 * `MagazineIssueContentsService` precedent: this is a public read that sources
 * from the desk's ISSUE-PRODUCTION jsonb, and keeping it separate keeps that
 * dependency out of the plain article/issue reads.
 *
 * Two rules stop the desk's private state leaking:
 *  - a slot is dropped unless its piece resolved to a PUBLISHED article, so a
 *    commissioned-but-unpublished piece never shows a headline the desk has
 *    not put in front of readers yet;
 *  - the ARTICLE is the source of the displayed headline, never the desk's
 *    working piece title, which gets rewritten on the way through production.
 *
 * Run-order slots holding a DECK are not resolved here. The front has always
 * given decks their own block (sourced from `GET /magazine/decks`), same as
 * the demo front does, and folding them into an article rail would mean a
 * card shape that is half article and half deck. A deck in the run order
 * still reaches the reader through that block.
 *
 * Four batched queries at most, never one per slot: the issue, its pieces,
 * their articles, and those articles' bylines.
 */
@Injectable()
export class MagazineFrontService {
  constructor(
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineAuthor)
    private readonly authors: Repository<MagazineAuthor>,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /**
   * The issue the masthead names and the front is arranged from: the most
   * recently published one. `published_on` is a Postgres `date`, so an issue
   * scheduled for a later day is not current yet, and an issue the desk has
   * opened but never scheduled (`NULL`) is not current at all.
   *
   * ONE definition of "current", shared by `getCurrentIssue` and `getFront`,
   * so the masthead can never name a different issue from the one whose run
   * order is on screen below it.
   */
  private findCurrentIssue(): Promise<MagazineIssue | null> {
    return this.issues
      .createQueryBuilder('issue')
      .where('issue.published_on IS NOT NULL')
      .andWhere('issue.published_on <= CURRENT_DATE')
      .orderBy('issue.published_on', 'DESC')
      .addOrderBy('issue.number', 'DESC')
      .getOne();
  }

  /** `GET /magazine/current-issue` — the masthead's issue label. */
  async getCurrentIssue(): Promise<IssueResponse | null> {
    const issue = await this.findCurrentIssue();
    if (!issue) {
      return null;
    }
    return toIssueResponse(issue, await this.cropsFor(issue));
  }

  async getFront(): Promise<MagazineFrontResponse> {
    const issue = await this.findCurrentIssue();
    if (!issue) {
      return { issue: null, lead: null, sections: [] };
    }

    const issueResponse = toIssueResponse(issue, await this.cropsFor(issue));
    const empty: MagazineFrontResponse = {
      issue: issueResponse,
      lead: null,
      sections: [],
    };
    const runOrder = issue.runOrder ?? [];
    if (runOrder.length === 0) {
      return empty;
    }

    const entries = await this.resolveRunOrder(
      runOrder.map((slot) => slot.pieceId),
    );
    const [lead, ...rest] = entries;
    return {
      issue: issueResponse,
      lead: lead ?? null,
      sections: groupBySection(rest),
    };
  }

  private cropsFor(issue: MagazineIssue) {
    return this.mediaCropService.getMany(
      issue.coverUrl ? [issue.coverUrl] : [],
    );
  }

  /**
   * Run-order piece ids in, front entries out, in the same order. Anything
   * that does not resolve to a published article with a byline is skipped
   * rather than rendered half-blank.
   */
  private async resolveRunOrder(
    pieceIds: string[],
  ): Promise<MagazineFrontEntry[]> {
    const pieces = await this.pieces.find({
      where: { id: In(pieceIds) },
      // Only the three fields the front reads. The full piece row carries the
      // desk's `brief`/`care` jsonb (rates, kill fees, consent tracking) and
      // has no business on a public read.
      select: { id: true, section: true, articleId: true, contentsBlurb: true },
    });
    const pieceById = new Map(pieces.map((piece) => [piece.id, piece]));

    const articleIds = pieces.flatMap((piece) =>
      piece.articleId ? [piece.articleId] : [],
    );
    if (articleIds.length === 0) {
      return [];
    }
    const articleRows = await this.articles.find({
      where: { id: In(articleIds) },
      // Same projection discipline as `MagazineService.listArticles`: no
      // `blocks` jsonb, no legacy `body`, no `contentNotes`.
      select: {
        id: true,
        slug: true,
        title: true,
        dek: true,
        kicker: true,
        standfirst: true,
        section: true,
        socialImage: true,
        heroImageKey: true,
        readMinutes: true,
        publishedAt: true,
        authorId: true,
      },
    });
    // Published only, and not scheduled for a later moment — the same gate
    // every other public magazine read uses.
    const now = new Date();
    const published = articleRows.filter(
      (article) => article.publishedAt !== null && article.publishedAt <= now,
    );
    const articleById = new Map(
      published.map((article) => [article.id, article]),
    );

    const authorRows = await this.authors.find({
      where: {
        id: In([...new Set(published.map((article) => article.authorId))]),
      },
    });
    const authorById = new Map(authorRows.map((author) => [author.id, author]));

    // CON-04 — ONE batched crop lookup for the whole front, never one per
    // slot, mirroring how the issue cover's crop is loaded above.
    const articleCrops = await this.mediaCropService.getMany(
      published.map((article) => article.heroImageKey).filter(Boolean),
    );

    const entries: MagazineFrontEntry[] = [];
    for (const pieceId of pieceIds) {
      const piece = pieceById.get(pieceId);
      const article = piece?.articleId
        ? articleById.get(piece.articleId)
        : undefined;
      const author = article ? authorById.get(article.authorId) : undefined;
      if (!piece || !article || !author) {
        continue;
      }
      entries.push({
        slug: article.slug,
        title: article.title,
        dek: article.dek,
        kicker: article.kicker,
        standfirst: article.standfirst,
        author: toAuthorSummary(author),
        // The desk's placement wins over the article's own free-text
        // `section`: the run order IS the desk saying where a piece runs.
        section: piece.section || article.section,
        blurb: piece.contentsBlurb,
        readMinutes: article.readMinutes,
        // CON-04 — the lead art first, the share image only as a fallback.
        // They are two separate editorial decisions and the art on the page is
        // the one this slot is showing.
        imageUrl:
          toImageUrl(article.heroImageKey) ?? toImageUrl(article.socialImage),
        imageCrop: cropFor(article.heroImageKey, articleCrops),
        publishedAt: article.publishedAt
          ? article.publishedAt.toISOString()
          : null,
      });
    }
    return entries;
  }
}

/**
 * Consecutive entries sharing a section become one rail. Consecutive, never
 * gathered: an editor who runs Features, then an essay, then Features again
 * meant that shape, and re-sorting the page into tidy buckets would throw
 * away the arrangement this whole endpoint exists to honour.
 */
function groupBySection(entries: MagazineFrontEntry[]): MagazineFrontSection[] {
  const sections: MagazineFrontSection[] = [];
  for (const entry of entries) {
    const current = sections[sections.length - 1];
    if (current && current.name === entry.section) {
      current.entries.push(entry);
      continue;
    }
    sections.push({ name: entry.section, entries: [entry] });
  }
  return sections;
}
