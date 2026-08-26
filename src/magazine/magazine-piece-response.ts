import {
  ArtState,
  MagazinePiece,
  PieceBrief,
  PieceCare,
  PieceFormat,
  PieceStage,
} from './entities/magazine-piece.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import {
  IssueDigestItem,
  MagazineIssue,
} from './entities/magazine-issue.entity';
import { MagazinePitch, PitchStatus } from './entities/magazine-pitch.entity';
import {
  MagazinePayment,
  PaymentStatus,
} from './entities/magazine-payment.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import {
  ArticleBlock,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import { toReadableBlocks } from './magazine-response';
import { Profile } from '../users/entities/profile.entity';
import { toImageUrl } from '../common/image-url';

/**
 * Response shapes below are hand-mapped (mirror `magazine-response.ts`) so
 * the editor desk read models never leak internal columns (e.g. `brief`/
 * `care` jsonb, `orderIndex`, `pages`, `laidOut`) into the list/pitch/summary
 * projections. `late`/`waitingOn` are derived here, never stored on the
 * entity (spec §4.3).
 */

export type WaitingOn = 'writer' | 'you' | 'nobody';

export interface PieceListItem {
  id: string;
  format: PieceFormat;
  title: string;
  section: string;
  kind: string | null;
  byline: string;
  editorId: string;
  writerId: string | null;
  stage: PieceStage;
  due: string | null;
  late: boolean;
  waitingOn: WaitingOn;
  words: number | null;
  slides: number | null;
  fresh: boolean;
  issueId: string | null;
  articleId: string | null;
  deckId: string | null;
  art: ArtState;
  contentsBlurb: string;
}

export interface PitchResponse {
  id: string;
  title: string;
  from: string;
  note: string;
  tags: string[];
  suggestFormat: PieceFormat | null;
  status: PitchStatus;
  fresh: boolean;
}

/**
 * One row of the `magazine_piece_event` trail (spec §3.4), shared by
 * `PieceRecord.audit` (the piece's History tab) and `DeskSummary.activity`
 * (the desk sidebar). Resolved down to display strings — the actor's name and
 * a human phrase for what happened — so neither surface renders a raw uuid or
 * a raw `action` enum. The two differ only in what the phrase calls the piece:
 * the desk feed
 * spans every piece so it names each one by title, while the History tab is
 * already on one piece and says "this piece". `when` stays the raw ISO
 * `createdAt` so the frontend formats it itself.
 */
export interface PieceEventEntry {
  id: string;
  /** Matches the editor directory (for an avatar); `null` for a system event.
   *  The visible attribution is always `who`. */
  actorId: string | null;
  /** True when nobody did this — a system-recorded event. */
  isSystem: boolean;
  who: string;
  what: string;
  when: string;
}

export interface DeskSummary {
  stageLoad: { stage: PieceStage; count: number }[];
  editorLoad: { editorId: string; count: number; cap: number }[];
  activity: PieceEventEntry[];
}

export interface PieceRecord extends PieceListItem {
  brief: PieceBrief | null;
  care: PieceCare | null;
  audit: PieceEventEntry[];
}

/**
 * True when `piece.dueOn` is a valid, past calendar date (UTC date compare,
 * ignoring time-of-day) and the piece hasn't reached `ready`. A ready piece
 * is never "late" — the desk only chases pieces still in flight. `now` is
 * injectable for deterministic tests; defaults to the real clock.
 */
export function deriveLate(
  piece: Pick<MagazinePiece, 'dueOn' | 'stage'>,
  now: Date = new Date(),
): boolean {
  if (piece.dueOn === null || piece.stage === 'ready') {
    return false;
  }

  const dueDate = new Date(piece.dueOn);
  if (Number.isNaN(dueDate.getTime())) {
    return false;
  }

  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dueUtc = Date.UTC(
    dueDate.getUTCFullYear(),
    dueDate.getUTCMonth(),
    dueDate.getUTCDate(),
  );

  return dueUtc < todayUtc;
}

/**
 * Whose court the piece is in: for `commissioned`/`drafting`, the writer
 * owes a draft ONLY once one is assigned — with no `writerId`, the editor
 * still owes the assignment itself, so it stays `'you'`. For `in_review`/
 * `edit`/`sensitivity_read`/`layout` the editor always owes an action, and
 * `ready` means nobody owes anything.
 */
export function deriveWaitingOn(
  piece: Pick<MagazinePiece, 'stage' | 'writerId'>,
): WaitingOn {
  if (piece.stage === 'commissioned' || piece.stage === 'drafting') {
    return piece.writerId === null ? 'you' : 'writer';
  }
  if (
    piece.stage === 'in_review' ||
    piece.stage === 'edit' ||
    piece.stage === 'sensitivity_read' ||
    piece.stage === 'layout'
  ) {
    return 'you';
  }
  return 'nobody';
}

export function toPieceListItem(piece: MagazinePiece): PieceListItem {
  return {
    id: piece.id,
    format: piece.format,
    title: piece.title,
    section: piece.section,
    kind: piece.kind,
    byline: piece.byline,
    editorId: piece.editorId,
    writerId: piece.writerId,
    stage: piece.stage,
    due: piece.dueOn,
    late: deriveLate(piece),
    waitingOn: deriveWaitingOn(piece),
    words: piece.wordTarget,
    slides: piece.slideTarget,
    fresh: piece.fresh,
    issueId: piece.issueId,
    articleId: piece.articleId,
    deckId: piece.deckId,
    art: piece.art,
    contentsBlurb: piece.contentsBlurb,
  };
}

export function toPitchResponse(pitch: MagazinePitch): PitchResponse {
  return {
    id: pitch.id,
    title: pitch.title,
    from: pitch.from,
    note: pitch.note,
    tags: pitch.tags,
    suggestFormat: pitch.suggestFormat,
    status: pitch.status,
    fresh: pitch.fresh,
  };
}

/**
 * Merges consecutive events sharing piece + actor + action into the first
 * (most recent, per the DESC-ordered `deskSummary()` query) one — a rapid
 * autosave burst on one piece shows as a single activity-feed row instead of
 * flooding the desk-wide feed. Repeats separated by other activity are left
 * distinct, since those represent separate editing sessions.
 */
function collapseRepeatedEvents(
  events: MagazinePieceEvent[],
): MagazinePieceEvent[] {
  const collapsed: MagazinePieceEvent[] = [];
  for (const event of events) {
    const previous = collapsed[collapsed.length - 1];
    if (
      previous &&
      previous.pieceId === event.pieceId &&
      previous.actorId === event.actorId &&
      previous.action === event.action
    ) {
      continue;
    }
    collapsed.push(event);
  }
  return collapsed;
}

/**
 * What the History tab's phrases call the piece. That trail is already on one
 * piece, so repeating its title on every line would only add noise.
 */
const AUDIT_SUBJECT_LABEL = 'this piece';

/**
 * Pure mapper from one `MagazinePieceEvent` to a display-ready
 * `PieceEventEntry`. Goes through `toEventActorLabel` and
 * `describePieceEventAction`, so one event reads identically wherever it
 * surfaces. `subject` is what the phrase should call the piece — its title on
 * the desk feed, `AUDIT_SUBJECT_LABEL` on a single piece's History tab.
 */
function toPieceEventEntry(
  event: MagazinePieceEvent,
  subject: string,
  actorNameById: Map<string, string>,
): PieceEventEntry {
  return {
    id: event.id,
    actorId: event.actorId,
    isSystem: event.actorId === null,
    who: toEventActorLabel(event.actorId, actorNameById),
    what: describePieceEventAction(event.action, event.detail, subject),
    when: event.createdAt.toISOString(),
  };
}

/**
 * Full piece record for `PieceRecordPage` (spec §4.3 `toPieceRecord`) — the
 * list projection plus the jsonb brief/care and the full audit trail. Editor
 * vs. writer projection narrowing (spec §4.3, phase 6) is deliberately out
 * of scope for this mapper; it returns the editor's full view.
 */
export function toPieceRecordSummary(
  piece: MagazinePiece,
  events: MagazinePieceEvent[],
  actorNameById: Map<string, string>,
): PieceRecord {
  return {
    ...toPieceListItem(piece),
    brief: piece.brief,
    care: piece.care,
    audit: events.map((event) =>
      toPieceEventEntry(event, AUDIT_SUBJECT_LABEL, actorNameById),
    ),
  };
}

/**
 * A single publish-gate row (spec §7.2 PublishGateCard): a human label plus
 * whether that blocker is settled. Only OPEN rows (`done: false`) actually
 * block publishing — the gate card renders both, but a caller checking
 * "can this publish?" should look for any `done === false`.
 */
export interface PublishGateItem {
  label: string;
  done: boolean;
}

/**
 * Derives the publish-gate checklist from a piece's `care` record (spec
 * §7.2, Task 3). Pure function of its input — no clock, no I/O — so it stays
 * trivially testable and safe to call from both the service and any future
 * read model.
 *
 * Order: consent per subject, then sensitivity read, then content notes.
 * A `null` care record (nothing filled in yet) short-circuits to a single
 * "not started" blocker rather than enumerating fields that don't exist.
 */
export function computePublishGate(care: PieceCare | null): PublishGateItem[] {
  if (care === null) {
    return [{ label: 'Care record not started', done: false }];
  }

  const items: PublishGateItem[] = [];

  for (const subject of care.subjects) {
    items.push({
      label: `Consent — ${subject.name}`,
      done: subject.consent !== 'pending',
    });
  }

  if (care.read === null) {
    items.push({ label: 'Sensitivity read not started', done: false });
  } else {
    for (const check of care.read.checks) {
      items.push({
        label: `Sensitivity read: ${check.label}`,
        done: check.done,
      });
    }
  }

  items.push({
    label: 'Content notes written',
    done: care.contentNotes.length > 0,
  });

  return items;
}

/**
 * The money side of a piece (CON-18). `fee` and `expenses` are DECIMAL
 * STRINGS off Postgres `numeric` ("420.00"), or `null` when that field has
 * never been priced. Never parse one into a JS `number` on the way to a
 * total: sum them server-side, where they stay exact.
 */
export interface PaymentResponse {
  /** ISO 4217 code both amounts on this row are in. */
  currency: string;
  fee: string | null;
  /** The fee as the desk originally wrote it, when it says more than the amount. */
  feeText: string | null;
  expenses: string | null;
  /** The expenses as the desk originally wrote them ("18 travel"). */
  expensesText: string | null;
  /** An invoice REFERENCE, never an amount. */
  invoice: string | null;
  filedOn: string | null;
  terms: string;
  dueOn: string | null;
  status: PaymentStatus;
  paidOn: string | null;
}

export interface LetterResponse {
  id: string;
  who: string;
  body: string;
  runInLetters: boolean;
  createdAt: string;
}

export interface CorrectionResponse {
  id: string;
  text: string;
  publishedOn: string | null;
  createdAt: string;
}

export type PieceRecordFull = PieceRecord & {
  payment: PaymentResponse | null;
  letters: LetterResponse[];
  corrections: CorrectionResponse[];
  publishGate: PublishGateItem[];
};

export function toPaymentResponse(payment: MagazinePayment): PaymentResponse {
  return {
    currency: payment.currency,
    fee: payment.feeAmount,
    feeText: payment.feeText,
    expenses: payment.expensesAmount,
    expensesText: payment.expensesText,
    invoice: payment.invoice,
    filedOn: payment.filedOn,
    terms: payment.terms,
    dueOn: payment.dueOn,
    status: payment.status,
    paidOn: payment.paidOn,
  };
}

export function toLetterResponse(letter: MagazineLetter): LetterResponse {
  return {
    id: letter.id,
    who: letter.who,
    body: letter.body,
    runInLetters: letter.runInLetters,
    createdAt: letter.createdAt.toISOString(),
  };
}

export function toCorrectionResponse(
  correction: MagazineCorrection,
): CorrectionResponse {
  return {
    id: correction.id,
    text: correction.text,
    publishedOn: correction.publishedOn,
    createdAt: correction.createdAt.toISOString(),
  };
}

/**
 * Full piece record for `PieceRecordPage` (spec §7.2, Task 3): the editor
 * summary plus the 1:1 payment row, the letters/corrections lists, and the
 * derived publish gate. Extends `toPieceRecordSummary` rather than
 * duplicating it.
 */
export function toPieceRecordFull(
  piece: MagazinePiece,
  events: MagazinePieceEvent[],
  actorNameById: Map<string, string>,
  payment: MagazinePayment | null,
  letters: MagazineLetter[],
  corrections: MagazineCorrection[],
): PieceRecordFull {
  return {
    ...toPieceRecordSummary(piece, events, actorNameById),
    payment: payment === null ? null : toPaymentResponse(payment),
    letters: letters.map(toLetterResponse),
    corrections: corrections.map(toCorrectionResponse),
    publishGate: computePublishGate(piece.care),
  };
}

/**
 * Desk-wide roll-up (spec §3.1 sidebar): how many pieces sit in each stage,
 * how loaded each editor is against their cap, and the most recent audit
 * activity across all pieces. `editors`, `titleByPieceId` and
 * `actorNameById` are all passed in (not queried here) so this mapper stays a
 * pure function of its inputs — the caller batches those lookups, mirroring
 * `listArticleComments`.
 */
export function toDeskSummary(
  pieces: MagazinePiece[],
  events: MagazinePieceEvent[],
  editors: { id: string; cap: number }[],
  titleByPieceId: Map<string, string>,
  actorNameById: Map<string, string>,
): DeskSummary {
  const countByStage = new Map<PieceStage, number>();
  const countByEditorId = new Map<string, number>();

  for (const piece of pieces) {
    countByStage.set(piece.stage, (countByStage.get(piece.stage) ?? 0) + 1);
    countByEditorId.set(
      piece.editorId,
      (countByEditorId.get(piece.editorId) ?? 0) + 1,
    );
  }

  const stageLoad = Array.from(countByStage.entries()).map(
    ([stage, count]) => ({ stage, count }),
  );

  const editorLoad = editors.map((editor) => ({
    editorId: editor.id,
    count: countByEditorId.get(editor.id) ?? 0,
    cap: editor.cap,
  }));

  return {
    stageLoad,
    editorLoad,
    activity: collapseRepeatedEvents(events).map((event) =>
      toPieceEventEntry(
        event,
        titleByPieceId.get(event.pieceId) ?? UNRESOLVED_TITLE_LABEL,
        actorNameById,
      ),
    ),
  };
}

/**
 * The article-editor draft (spec §7.3, plan Phase 3 Task 3) — everything the
 * block editor needs for one `MagazinePiece.articleId`-linked
 * `MagazineArticle`. `readMinutes` is DERIVED here rather than trusted off
 * the stored column, so it's always in sync with the current `blocks`
 * (mirrors `deriveLate`/`deriveWaitingOn`: never store what you can compute).
 */
export interface ArticleDraftResponse {
  id: string;
  slug: string;
  title: string;
  standfirst: string;
  kicker: string;
  section: string;
  role: string;
  metaDescription: string;
  socialImage: string;
  canonicalUrl: string;
  /**
   * CON-04 — the piece's lead art, served as the RESOLVED `/files/<key>` URL
   * rather than the bare key, because the editor's upload field renders it
   * directly and a private storage key is not fetchable. `null` when the desk
   * has not commissioned art yet.
   *
   * The editor re-sends this exact value as `UpdateArticleDto.heroImageKey`
   * when it saves anything else on the piece; the global
   * `StorageKeyOwnershipInterceptor` collapses it back to the bare key before
   * the service persists it, so the column stays canonical. Same round-trip
   * every other upload-backed edit form in the app uses (see
   * `Community.coverImageUrl`).
   */
  heroImageUrl: string | null;
  tags: string[];
  contentNotes: string[];
  blocks: ArticleBlock[];
  readMinutes: number;
  publishedAt: string | null;
  /** Optimistic-concurrency counter. Round-trip it as `expectedVersion` on the
   *  next save so a stale tab gets a 409 instead of silently overwriting
   *  somebody else's blocks. See `MagazineArticle.version`. */
  version: number;
}

const WORDS_PER_MINUTE = 220;

/** Strips HTML tags (`<...>`) from a fragment, leaving plain text behind. */
export function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

// The named character references a contentEditable actually emits. `&nbsp;`
// becomes an ordinary space (the whitespace collapse below then folds it into
// its neighbours), which is what a reader sees anyway.
const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Collapses a rich-text fragment to the PLAIN TEXT a reader sees: tags removed,
 * character references resolved, whitespace collapsed, trimmed.
 *
 * Used at the WRITE boundary for every field that is declared plain text and
 * rendered as text (`MagazineArticle.title`, the `MagazinePiece.title` mirror,
 * the slug source). A contentEditable headline hands the server its raw
 * `innerHTML` — `<div>A <em>bold</em> claim</div>` — and storing that verbatim
 * means every consumer has to strip it again on read: the article page, the
 * archive list, search results, the digest email, OG tags. Some of them do not,
 * so readers see literal `<em>` in a headline. Normalising ONCE here keeps the
 * column honest for every reader, including ones that do not exist yet.
 *
 * Decoding `&lt;`/`&gt;` yields real `<`/`>` CHARACTERS in a plain-text column,
 * which is correct — the value is text, and every HTML consumer escapes it
 * (`mail-templates.ts`'s `escapeHtml`, React's JSX text nodes). Leaving them
 * encoded would print a literal `&lt;` to the reader instead.
 */
export function toPlainText(html: string): string {
  return stripHtmlTags(html)
    .replace(
      /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,31});/g,
      (match, reference: string) => {
        if (reference.startsWith('#')) {
          const isHex = reference[1] === 'x' || reference[1] === 'X';
          const codePoint = isHex
            ? Number.parseInt(reference.slice(2), 16)
            : Number.parseInt(reference.slice(1), 10);
          // Surrogates and out-of-range code points would throw; leave those
          // (and anything unrecognised) exactly as they arrived.
          if (
            !Number.isFinite(codePoint) ||
            codePoint <= 0 ||
            codePoint > 0x10ffff ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ) {
            return match;
          }
          return String.fromCodePoint(codePoint);
        }
        return NAMED_HTML_ENTITIES[reference.toLowerCase()] ?? match;
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Counts the whitespace-delimited words in a (possibly HTML) fragment. */
function countWordsInText(text: string): number {
  const stripped = stripHtmlTags(text).trim();
  return stripped.length === 0 ? 0 : stripped.split(/\s+/).length;
}

/**
 * Total word count across an `ArticleBlock[]`, reading the human-authored
 * text field(s) of each kind (`html`/`q`/`items[].value`+`.label`/`caption`)
 * and stripping markup first. Pure — no I/O, no clock — so `readMinutes` can
 * be derived from it safely on every read.
 */
export function countArticleWords(blocks: ArticleBlock[]): number {
  let total = 0;

  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
      case 'pullQuote':
      case 'quote':
        total += countWordsInText(block.html ?? '');
        break;
      case 'image':
        total += countWordsInText(block.caption ?? '');
        break;
      case 'qa':
        total +=
          countWordsInText(block.q ?? '') + countWordsInText(block.html ?? '');
        break;
      case 'stats':
        for (const item of block.items ?? []) {
          total +=
            countWordsInText(item.value ?? '') +
            countWordsInText(item.label ?? '');
        }
        break;
    }
  }

  return total;
}

/**
 * Pure mapper from the stored entity to `ArticleDraftResponse`. `readMinutes`
 * is always recomputed from `blocks` (see `countArticleWords`) — a freshly
 * created empty draft (`blocks: []`) reads as 1 minute, never 0.
 */
export function toArticleDraftResponse(
  article: MagazineArticle,
): ArticleDraftResponse {
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    standfirst: article.standfirst,
    kicker: article.kicker,
    section: article.section,
    role: article.role,
    metaDescription: article.metaDescription,
    socialImage: article.socialImage,
    canonicalUrl: article.canonicalUrl,
    heroImageUrl: toImageUrl(article.heroImageKey),
    tags: article.tags,
    contentNotes: article.contentNotes,
    // CON-04 — an uploaded image block holds a storage key, which the editor
    // cannot render. Resolved on the way out and collapsed back to a key by
    // the ownership interceptor on the way in (see `toReadableBlocks`).
    blocks: toReadableBlocks(article.blocks),
    readMinutes: Math.max(
      1,
      Math.ceil(countArticleWords(article.blocks) / WORDS_PER_MINUTE),
    ),
    publishedAt:
      article.publishedAt === null ? null : article.publishedAt.toISOString(),
    version: article.version,
  };
}

/**
 * Whether an article draft has the minimum an editor must fill in before a
 * fresh publish (mirrors the frontend's `articlePublishChecklist.ts`
 * REQUIRED items exactly, so the client-side checklist and this server-side
 * gate never disagree): a non-empty standfirst, and every image block's
 * `alt` text filled in. Only gates a null -> true `publishedAt` transition
 * (see `publishArticle`'s use) — re-publishing/rescheduling or unpublishing
 * an already-live article is never blocked by it, same as the deck's publish
 * toggle never re-checks a live deck's draft state.
 */
export function isArticlePublishReady(article: MagazineArticle): boolean {
  const hasStandfirst = stripHtmlTags(article.standfirst).trim() !== '';
  const imageBlocks = article.blocks.filter(
    (block): block is Extract<ArticleBlock, { kind: 'image' }> =>
      block.kind === 'image',
  );
  const everyImageHasAlt = imageBlocks.every(
    (block) => block.alt.trim() !== '',
  );
  return hasStandfirst && everyImageHasAlt;
}

/**
 * One slot in the issue-production running order (Magazine Desk Phase 5,
 * spec §7.5): the resolved piece plus its planned page range and whether
 * it's laid out yet. `pages` is echoed from `IssueRunOrderItem` rather than
 * `piece.pages` directly, since the two are kept in sync by
 * `MagazinePieceService.updateRunOrder` but the run-order entry is the
 * source of truth for display order.
 */
export interface IssueRunOrderEntry {
  piece: PieceListItem;
  pages: string;
  laidOut: boolean;
}

/**
 * The issue-production read model (Magazine Desk Phase 5, spec §7.5) behind
 * `/magazine/editor/issue/:number`: running order, cover & coverlines,
 * members' digest, and a pre-ship checklist. Hand-mapped like every other
 * response in this file — never the raw `MagazineIssue`/`MagazinePiece` rows.
 */
export interface IssueProductionResponse {
  number: string;
  theme: string;
  title: string;
  publishedOn: string | null;
  coverUrl: string;
  coverlines: string[];
  runOrder: IssueRunOrderEntry[];
  digest: IssueDigestItem[];
  /** CNT-6 "Schedule with issue" toggle + send watermark — see `MagazineIssue`. */
  digestSendOnPublish: boolean;
  digestSentAt: string | null;
  shipChecklist: PublishGateItem[];
  pages: { editorial: number; total: number; max: number };
}

/** `pages.max`: the flat print-page budget for an issue (spec §7.5 design). */
const ISSUE_MAX_PAGES = 30;

/**
 * Orders pieces without a `runOrder` entry yet (spec §7.5 Task 2 fallback):
 * by `orderIndex` ascending, pieces with no `orderIndex` last, ties broken
 * by `createdAt` (oldest first) so the fallback order is stable.
 */
function sortPiecesForFallbackRunOrder(
  pieces: MagazinePiece[],
): MagazinePiece[] {
  return [...pieces].sort((left, right) => {
    if (left.orderIndex === null && right.orderIndex === null) {
      return left.createdAt.getTime() - right.createdAt.getTime();
    }
    if (left.orderIndex === null) {
      return 1;
    }
    if (right.orderIndex === null) {
      return -1;
    }
    return left.orderIndex - right.orderIndex;
  });
}

/**
 * Pure mapper from the stored `MagazineIssue` + its `MagazinePiece`s to
 * `IssueProductionResponse` (spec §7.5 Task 2). `issue.runOrder` entries are
 * resolved against `pieces`, silently dropping any `pieceId` that no longer
 * matches a piece (e.g. a deleted piece never cleaned out of the jsonb list).
 * When `issue.runOrder` is empty (a fresh issue nobody has arranged yet),
 * falls back to every piece on the issue ordered by `orderIndex`.
 *
 * Pieces assigned to the issue AFTER a running order was saved are appended
 * to the end rather than dropped. `runOrder` is a hand-curated jsonb list
 * that only `updateRunOrder` writes, so assignment (which touches
 * `magazine_piece.issueId` alone) would otherwise leave the new piece
 * invisible on the production page while still counting toward the issue's
 * slot fill and ship gate — the running order and the issue's actual
 * contents would disagree. Self-healing: the moment an editor saves the
 * order, the appended entries become real `runOrder` items.
 */
export function toIssueProduction(
  issue: MagazineIssue,
  pieces: MagazinePiece[],
): IssueProductionResponse {
  const pieceById = new Map(pieces.map((piece) => [piece.id, piece]));

  const orderedPieceIds = new Set(issue.runOrder.map((item) => item.pieceId));
  const unorderedPieces = pieces.filter(
    (piece) => !orderedPieceIds.has(piece.id),
  );

  const runOrder: IssueRunOrderEntry[] =
    issue.runOrder.length > 0
      ? [
          ...issue.runOrder.flatMap((item): IssueRunOrderEntry[] => {
            const piece = pieceById.get(item.pieceId);
            if (!piece) {
              return [];
            }
            return [
              {
                piece: toPieceListItem(piece),
                pages: item.pages,
                laidOut: piece.laidOut,
              },
            ];
          }),
          ...sortPiecesForFallbackRunOrder(unorderedPieces).map((piece) => ({
            piece: toPieceListItem(piece),
            pages: piece.pages ?? '',
            laidOut: piece.laidOut,
          })),
        ]
      : sortPiecesForFallbackRunOrder(pieces).map((piece) => ({
          piece: toPieceListItem(piece),
          pages: piece.pages ?? '',
          laidOut: piece.laidOut,
        }));

  const shipChecklist: PublishGateItem[] = [
    {
      label: 'Every piece past the publish gate',
      done: pieces.every((piece) =>
        computePublishGate(piece.care).every((gate) => gate.done),
      ),
    },
    { label: 'Cover art set', done: Boolean(issue.coverUrl) },
    { label: 'Coverlines written', done: issue.coverlines.length > 0 },
    {
      label: '"In this issue" panel lists at least one piece',
      done: issue.digest.some((entry) => entry.on),
    },
  ];

  return {
    number: issue.number,
    theme: issue.theme,
    title: issue.title,
    publishedOn: issue.publishedOn ? issue.publishedOn : null,
    coverUrl: issue.coverUrl ?? '',
    coverlines: issue.coverlines,
    runOrder,
    digest: issue.digest,
    digestSendOnPublish: issue.digestSendOnPublish,
    digestSentAt: issue.digestSentAt ? issue.digestSentAt.toISOString() : null,
    shipChecklist,
    pages: {
      editorial: runOrder.length,
      total: runOrder.length,
      max: ISSUE_MAX_PAGES,
    },
  };
}

/**
 * One entry in the editor directory (Magazine Desk Phase 7, Task A1): every
 * user holding the `magazine_editor` staff role, plus admins (a superset,
 * mirroring `StaffRolesGuard`). Hand-mapped from `User`/`Profile` — never
 * the raw rows — so this NEVER carries `email`, `googleId`, or any other
 * account column, only what the "viewing as" picker and the sidebar editor
 * load need to render a name.
 */
export interface MagazineEditorResponse {
  id: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
}

/**
 * Two-letter monogram from a display name, matching the initials convention
 * used elsewhere in the platform (see `admin-communities-response.ts#initialsFor`)
 * — duplicated locally rather than imported cross-module, since this is the
 * only place in the magazine module that needs it.
 */
/**
 * Full name from a `Profile`, trimmed — the same "public display name only"
 * shape `toMagazineEditor` exposes. Reused by `listArticleComments`'s
 * batched fallback lookup for actors the editor directory doesn't recognise
 * (e.g. a writer), so a non-editor actor's `who` resolves to their real name
 * rather than a role-specific "editor" fallback. NEVER exposes email or any
 * other account column.
 */
export function toActorDisplayName(profile: Profile): string {
  return `${profile.firstName} ${profile.lastName}`.trim();
}

function initialsForName(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) return '··';
  const firstWord = words[0] ?? '';
  if (words.length === 1) return firstWord.slice(0, 2).toUpperCase();
  const secondWord = words[1] ?? '';
  return ((firstWord[0] ?? '') + (secondWord[0] ?? '')).toUpperCase();
}

/**
 * Pure mapper from a `userId` + its `Profile` to `MagazineEditorResponse`.
 * Returns `null` when the user has no profile row (defensive — every active
 * member has one) so the caller can filter it out rather than fabricate a
 * name.
 */
export function toMagazineEditor(
  userId: string,
  profile: Profile | null,
): MagazineEditorResponse | null {
  if (!profile) return null;
  const name = toActorDisplayName(profile);
  return {
    id: userId,
    name,
    initials: initialsForName(name),
    avatarUrl: toImageUrl(profile.avatarUrl),
  };
}

/**
 * The desk header's "current issue" read model (Magazine Desk Phase 7, Task
 * A2): just enough for the header/Produce-button gate — the full production
 * record is `IssueProductionResponse` (`GET /magazine/admin/issues/:number`).
 * `slots` is the sum of every seeded `MagazineSection.target` (spec §3.5),
 * not a magic constant, so it moves if section targets ever change.
 */
export interface CurrentIssueSummary {
  id: string;
  number: string;
  theme: string;
  filled: number;
  slots: number;
}

/**
 * One row of the desk's issue switcher (`GET /magazine/admin/issues`).
 * Extends the current-issue read model with the fields the switcher and the
 * new-issue modal need: `title` for the option label and `publishedOn` for
 * the header meta line.
 *
 * The public `GET /magazine/issues` cannot serve this list: it projects
 * `id` and `theme` away on purpose (`MagazineService.listIssues`), and `id`
 * is exactly what the desk writes onto `magazine_piece.issueId`.
 */
export interface IssueSummaryResponse extends CurrentIssueSummary {
  title: string;
  /** `YYYY-MM-DD`, or `null` while the issue is still unscheduled. */
  publishedOn: string | null;
}

/**
 * One row of the editor desk's archive search (Magazine Desk Phase 7, Task
 * B1): a published article or deck, hand-mapped down to just what the
 * ArchiveTab renders. `issue` is the resolved issue's display `number`
 * (never a uuid) — `null` when the piece ran web-only or (for decks, which
 * have no `issueId` at all) always.
 */
export interface ArchiveEntryResponse {
  title: string;
  issue: string | null;
  by: string;
  tags: string[];
}

/**
 * Pure mapper from a published `MagazineArticle` to `ArchiveEntryResponse`.
 * `authorName` and `issueNumber` are resolved by the caller (a batched
 * lookup, mirroring `MagazineService.toListItems`) rather than queried here,
 * so this stays a pure function of its inputs.
 */
export function toArchiveEntryFromArticle(
  article: MagazineArticle,
  authorName: string,
  issueNumber: string | null,
): ArchiveEntryResponse {
  return {
    title: article.title,
    issue: issueNumber,
    by: authorName,
    tags: article.tags,
  };
}

/**
 * Pure mapper from a published `MagazineDeck` to `ArchiveEntryResponse`. A
 * deck has no `issueId` (see the entity), so `issue` is always `null`.
 */
export function toArchiveEntryFromDeck(
  deck: MagazineDeck,
): ArchiveEntryResponse {
  return {
    title: deck.title,
    issue: null,
    by: deck.byline,
    tags: deck.tags,
  };
}

/** Neutral fallback labels — NEVER an email or raw uuid (spec §C1). */
const SYSTEM_ACTOR_LABEL = 'System';
/**
 * Role-neutral — deliberately NOT "An editor": the actor behind an event is
 * often a writer (e.g. `filed`), not an editor, and this label is only ever
 * reached once both the editor directory AND a batched `Profile` lookup have
 * failed to resolve a name (see `listArticleComments`).
 */
const UNRESOLVED_ACTOR_LABEL = 'Someone on the team';
const UNRESOLVED_TITLE_LABEL = 'a piece';

/**
 * Resolves an event's `actorId` to a display name via the merged actor-name
 * map the caller builds (`resolveActorDisplayNames`): the Wave A editor
 * directory first, then a batched `Profile` lookup (via `toActorDisplayName`)
 * for any actor the directory doesn't recognise — most commonly a writer,
 * who is never in the editor directory but still has a truthful name to
 * show. `null` (the entity's documented "System" sentinel, see
 * `MagazinePieceEvent.actorId`) always reads as "System"; an id that's
 * unresolved even after both lookups (no profile row at all) falls back to
 * the role-neutral `UNRESOLVED_ACTOR_LABEL` rather than guessing at a name or
 * leaking the id.
 */
function toEventActorLabel(
  actorId: string | null,
  actorNameById: Map<string, string>,
): string {
  if (actorId === null) return SYSTEM_ACTOR_LABEL;
  return actorNameById.get(actorId) ?? UNRESOLVED_ACTOR_LABEL;
}

/** `stage_changed`'s `detail` is a raw `PieceStage`; renders as words. */
function humanizeStage(stage: string): string {
  return stage.replace(/_/g, ' ');
}

/**
 * Human, factual phrase for one event action (spec §C1 examples: "moved
 * {title} to edit", "logged a payment on {title}", "filed a draft of
 * {title}"). Every named branch mirrors an `action` string `recordEvent`
 * actually writes elsewhere in this service (`magazine-piece.service.ts`) —
 * an action added later without a branch here still reads sensibly via the
 * default case rather than throwing. `subject` is whatever the caller wants
 * the piece called: its title across a multi-piece feed, "this piece" on the
 * piece's own History tab.
 */
function describePieceEventAction(
  action: string,
  detail: string | null,
  subject: string,
): string {
  switch (action) {
    case 'commissioned':
      return `commissioned ${subject}`;
    case 'started_writing':
      return `started writing ${subject}`;
    case 'stage_changed':
      return `moved ${subject} to ${detail ? humanizeStage(detail) : 'a new stage'}`;
    case 'assigned':
      if (detail === 'writer:unassigned') {
        return `unassigned the writer from ${subject}`;
      }
      if (detail?.startsWith('writer:')) {
        return `assigned ${subject} to a writer`;
      }
      if (detail?.startsWith('editor:')) {
        return `reassigned the editor on ${subject}`;
      }
      return `reassigned ${subject}`;
    case 'deleted':
      return `deleted ${subject}`;
    case 'payment_updated':
      return `logged a payment on ${subject}`;
    case 'correction_published':
      return `published a correction on ${subject}`;
    case 'run_order_updated':
      return `updated the run order for ${subject}`;
    case 'issue_shipped':
      return detail ? `shipped ${subject} in ${detail}` : `shipped ${subject}`;
    case 'filed':
      return `filed a draft of ${subject}`;
    case 'article_created':
      return `opened the article draft for ${subject}`;
    case 'article_edited':
      return `edited the article draft for ${subject}`;
    case 'article_published':
      return `published ${subject}`;
    case 'article_scheduled':
      return `scheduled ${subject} to publish`;
    case 'article_unpublished':
      return `unpublished ${subject}`;
    case 'commented':
      return `left a note on ${subject}`;
    case 'version_restored':
      return `restored an earlier draft of ${subject}`;
    case 'converted_to_article':
      return detail
        ? `converted ${subject} into an article (${detail})`
        : `converted ${subject} into an article`;
    default:
      return `${action.replace(/_/g, ' ')} ${subject}`.trim();
  }
}
