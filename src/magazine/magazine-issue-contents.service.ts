import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';

/** What kind of page an entry opens. */
export type IssueContentsEntryKind = 'article' | 'deck';

/** One line of the reader-facing "In this issue" panel. */
export interface IssueContentsEntry {
  /** The published piece's own headline. */
  title: string;
  /** The desk's one-line blurb, written on the issue-production page. */
  blurb: string;
  /** Desk section the piece ran under ("Features", "Last word", …). */
  section: string;
  kind: IssueContentsEntryKind;
  /** Slug of the article or deck this entry opens. */
  slug: string;
}

/** `GET /magazine/issues/:number/contents`. */
export interface IssueContentsResponse {
  number: string;
  title: string;
  /** `YYYY-MM-DD`, or `null` while the issue is still unscheduled. */
  publishedOn: string | null;
  /** In the desk's curated order. Empty when nothing is curated yet. */
  entries: IssueContentsEntry[];
}

/**
 * The reader-facing "In this issue" panel (CON-05).
 *
 * The desk has always curated this list: which pieces lead, in what order,
 * each with a blurb written by hand. Until now its only destination was an
 * EMAIL — the members' digest, queued per subscriber on ship and drained by a
 * cron. QueerPulse delivers no email, so that path is deleted and this is
 * where the curation lands instead: the issue's own page.
 *
 * `magazine_issue.digest` (jsonb: `{ pieceId, blurb, on }[]`) is the source,
 * and ARRAY ORDER IS THE RUNNING ORDER, exactly as the editor arranged it.
 *
 * Three rules keep this from leaking the desk's private state:
 *  - the issue itself must have published (CON-18), so an embargoed number
 *    404s here instead of returning its title and date;
 *  - only entries the editor marked `on` are read at all;
 *  - an entry is dropped unless its piece resolved to a PUBLISHED article or
 *    deck. A commissioned-but-unpublished piece has a title the desk has not
 *    put in front of readers yet, and a curated blurb is no reason to.
 * Both together mean a curated issue that has not shipped renders an empty
 * panel rather than tomorrow's contents.
 *
 * Three batched queries, never one per entry: the pieces, then their articles
 * and decks by id.
 */
@Injectable()
export class MagazineIssueContentsService {
  constructor(
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineDeck)
    private readonly decks: Repository<MagazineDeck>,
  ) {}

  async getContents(issueNumber: string): Promise<IssueContentsResponse> {
    const issue = await this.issues.findOne({
      // CON-18 — the same embargo gate the other two public issue reads run
      // (`MagazineService.listIssues`/`getIssueByNumber`). Dropping the
      // unpublished ENTRIES was never enough on its own: the response still
      // named an unshipped issue and dated it, so guessing the next number
      // read back the desk's working title. NULL and future `published_on`
      // both fail `<= today` and 404.
      where: {
        number: issueNumber,
        publishedOn: LessThanOrEqual(new Date().toISOString().slice(0, 10)),
      },
    });
    if (!issue) {
      throw new NotFoundException('Issue not found');
    }

    const curated = issue.digest.filter((item) => item.on);
    const empty: IssueContentsResponse = {
      number: issue.number,
      title: issue.title,
      publishedOn: issue.publishedOn,
      entries: [],
    };
    if (curated.length === 0) {
      return empty;
    }

    const pieces = await this.pieces.find({
      where: { id: In(curated.map((item) => item.pieceId)) },
      select: { id: true, section: true, articleId: true, deckId: true },
    });
    const pieceById = new Map(pieces.map((piece) => [piece.id, piece]));

    const articleIds = pieces.flatMap((piece) =>
      piece.articleId ? [piece.articleId] : [],
    );
    const deckIds = pieces.flatMap((piece) =>
      piece.deckId ? [piece.deckId] : [],
    );
    const articleById = new Map(
      (articleIds.length
        ? await this.articles.find({
            where: { id: In(articleIds) },
            select: { id: true, slug: true, title: true, publishedAt: true },
          })
        : []
      ).map((article) => [article.id, article]),
    );
    const deckById = new Map(
      (deckIds.length
        ? await this.decks.find({
            where: { id: In(deckIds) },
            select: { id: true, slug: true, title: true, publishedAt: true },
          })
        : []
      ).map((deck) => [deck.id, deck]),
    );

    const entries: IssueContentsEntry[] = [];
    for (const item of curated) {
      const piece = pieceById.get(item.pieceId);
      if (!piece) {
        continue;
      }
      // The published ARTICLE (or deck) is the source of the displayed
      // headline, never the desk's working piece title: a piece is renamed on
      // its way through production, and the reader should see what the byline
      // page says.
      const article = piece.articleId
        ? articleById.get(piece.articleId)
        : undefined;
      if (article?.publishedAt) {
        entries.push({
          title: article.title,
          blurb: item.blurb,
          section: piece.section,
          kind: 'article',
          slug: article.slug,
        });
        continue;
      }
      const deck = piece.deckId ? deckById.get(piece.deckId) : undefined;
      if (deck?.publishedAt) {
        entries.push({
          title: deck.title,
          blurb: item.blurb,
          section: piece.section,
          kind: 'deck',
          slug: deck.slug,
        });
      }
    }

    return { ...empty, entries };
  }
}
