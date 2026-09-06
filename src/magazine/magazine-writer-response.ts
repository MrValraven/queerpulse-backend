import {
  ArticleBlock,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece, PieceStage } from './entities/magazine-piece.entity';
import { MagazinePitch, PitchStatus } from './entities/magazine-pitch.entity';
import {
  MagazinePayment,
  PaymentStatus,
} from './entities/magazine-payment.entity';
import { moneyDisplay } from './magazine-money';
import { countArticleWords } from './magazine-piece-response';
import { toReadableBlocks } from './magazine-response';

/**
 * Response shapes below are hand-mapped and deliberately SEPARATE from the
 * editor projections in `magazine-piece-response.ts` (Magazine Desk Phase 6,
 * Task 1). A writer must never receive another contributor's row, the
 * editor "viewing as" roster, or internal editor notes/comments (`care`,
 * the full `audit` trail) — these mappers project only what the writer who
 * owns the underlying piece/pitch/payment is meant to see.
 *
 * Callers are responsible for the ownership check itself (scoping the
 * `MagazinePiece`/`MagazinePitch` query to `writerId`/`submitterId` before
 * it ever reaches these mappers); these functions only shape the output.
 */

/**
 * The writer-facing "agreed terms" block (Magazine Desk Phase 7, Task B2):
 * `killFee` is the ONE genuinely per-assignment term, read off the piece's
 * editor-authored `brief.killFee` — `rights`/`edits` are the same static
 * house terms for every commission (there is no per-piece column for them
 * yet), spelled out plainly rather than left as a vague label.
 */
export interface WriterAssignmentTerms {
  killFee: string;
  rights: string;
  edits: string;
}

export interface WriterAssignmentResponse {
  id: string;
  title: string;
  section: string;
  due: string | null;
  /**
   * The stage as an ENGLISH sentence ("With your editor"), composed here.
   * Kept for wire compatibility with clients that render it directly, and it
   * is the reason `stage` exists beside it: a Portuguese reader was being
   * shown this field's English, because only the client knows the reader's
   * language. Compose from `stage` instead; this stays as the fallback.
   */
  state: string;
  /**
   * The raw pipeline stage, deliberately the machine value, exactly like
   * `pay` below. The writer workspace maps it to a translated label.
   */
  stage: PieceStage;
  words: number | null;
  target: number | null;
  fee: string;
  /**
   * The raw payment `status`, deliberately left as the machine value: the
   * writer workspace translates it (`AssignmentCard`), and only the client
   * knows which language to translate into. `'agreed'` stands in for a piece
   * with no payment row yet, which is the same thing the desk means by it.
   */
  pay: PaymentStatus;
  note: string;
  byline: string;
  terms: WriterAssignmentTerms;
  /**
   * Full brief detail for "Read the brief" (CNT-6) — writer-safe fields off
   * `PieceBrief` beyond `note`/`words`/`target`/`terms.killFee` above. Still
   * scoped by the same rule as the rest of this file: brief-adjacent fields
   * only, never internal editor notes/comments/`care`.
   */
  wants: string[];
  avoid: string;
  rate: string;
  commissionedBy: string;
  commissionedOn: string;
}

/** Static house terms shared by every commission (see `WriterAssignmentTerms`). */
const HOUSE_RIGHTS_TERM = 'first publication, you keep the rest';
const HOUSE_EDITS_TERM = 'you see them before they ship';

export interface WriterPitchResponse {
  id: string;
  title: string;
  sent: string;
  /**
   * The triage outcome as an ENGLISH sentence, with the editor's pass note
   * folded in when there is one. Same story as
   * `WriterAssignmentResponse.state`: kept for wire compatibility, superseded
   * by `status` + `passNote`, which a client can say in the reader's own
   * language while leaving the editor's words alone.
   */
  state: string;
  /** The raw triage `status`, left as the machine value so the client
   *  translates it. */
  status: PitchStatus;
  /**
   * The editor's own pass note, VERBATIM: authored text, never a catalog
   * string, never truncated here. `null` on every pitch that has not been
   * passed, so a note written on a pass that was later moved back to `maybe`
   * cannot resurface next to a state it no longer explains.
   */
  passNote: string | null;
  tone: 'hold' | 'no' | 'live';
}

/**
 * The issue fields a writer's payment row shows. The caller loads the issue
 * (the piece carries only `issueId`) and hands it to `toWriterPayment`; a
 * `Pick` rather than the whole entity keeps it obvious that nothing else off
 * an issue row is meant to reach a writer.
 */
export type WriterPaymentIssue = Pick<MagazineIssue, 'id' | 'number' | 'title'>;

export interface WriterPaymentResponse {
  title: string;
  /**
   * The issue's DISPLAY number ("09"), which is what every magazine surface
   * shows and links by (`GET /magazine/issues/:number`). This used to carry
   * `piece.issueId`, so the payments tab printed a UUID at the writer. `null`
   * while the piece is unscheduled, or while the caller has not loaded the
   * issue.
   */
  issue: string | null;
  /** The issue row id, kept for any caller that needs to address the row. */
  issueId: string | null;
  /** The issue's title, so a payment can read "Issue 09 · The body issue". */
  issueTitle: string | null;
  fee: string;
  /**
   * The composed human sentence ("Paid 14 Jun 2026"). The three fields below
   * carry the same thing unformatted, so a client can compose its own
   * translated wording instead of parsing this string.
   */
  state: string;
  /** `null` when no payment row has been agreed for the piece yet. */
  status: PaymentStatus | null;
  /** `yyyy-mm-dd`, or `null`. */
  dueOn: string | null;
  /** `yyyy-mm-dd`, or `null`. */
  paidOn: string | null;
}

/**
 * Human label for a piece's `stage`, from the writer's point of view (spec
 * §7.6 design `mag-contrib.jsx`: "With your editor" for `edit`, etc.), a
 * different vocabulary from any editor-facing label, so it is NOT shared
 * with `magazine-piece-response.ts`.
 *
 * ENGLISH, composed on the server, which means it is wrong for every reader
 * who is not reading in English. It survives only as `state`'s fallback value
 * for existing clients; the writer workspace translates `stage` itself. Do
 * not add a case here expecting anyone to read it.
 */
function stageToWriterState(stage: PieceStage): string {
  switch (stage) {
    case 'commissioned':
      return 'Commissioned';
    case 'drafting':
      return 'Drafting';
    case 'in_review':
      return 'In review';
    case 'edit':
      return 'With your editor';
    case 'sensitivity_read':
      return 'Sensitivity read';
    case 'layout':
      return 'In layout';
    case 'ready':
      return 'Ready';
    case 'published':
      // Terminal stage (PRD-120). Without this case the switch stopped being
      // exhaustive the moment `published` was added to `PieceStage`, and a
      // writer whose piece had been live for months still read "Ready".
      return 'Published';
  }
}

/**
 * The fee as the writer should read it (CON-18): the priced amount with its
 * currency ("€420.00"), falling back to whatever the desk wrote before the
 * row was ever priced, and to an empty string when no payment row exists.
 * Both writer surfaces show a display string rather than a raw amount, so
 * the formatting happens once, here.
 */
function writerFacingFee(payment: MagazinePayment | null): string {
  if (payment === null) {
    return '';
  }
  return moneyDisplay(payment.currency, payment.feeAmount, payment.feeText);
}

/**
 * "19 Aug 2026" from a Postgres `date` string. The sentences this lands in
 * ("Paid …", "Agreed: due …") are composed here in English, so the date is
 * formatted to match them rather than shipped as the raw `2026-08-19` a
 * writer was previously reading off their own payments tab.
 *
 * `en-GB` because the surrounding words are English and day-month-year is the
 * order the desk writes in. A client that wants the reader's own locale has
 * `status`/`dueOn`/`paidOn` on the response to compose from.
 */
function writerFacingDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export function toWriterAssignment(
  piece: MagazinePiece,
  payment: MagazinePayment | null,
): WriterAssignmentResponse {
  return {
    id: piece.id,
    title: piece.title,
    section: piece.section,
    due: piece.dueOn,
    state: stageToWriterState(piece.stage),
    stage: piece.stage,
    words: piece.brief?.filedWords ?? null,
    target: piece.brief?.wordCount ?? null,
    fee: writerFacingFee(payment),
    pay: payment?.status ?? 'agreed',
    note: piece.brief?.angle ?? '',
    byline: piece.byline,
    terms: {
      killFee: piece.brief?.killFee ?? '',
      rights: HOUSE_RIGHTS_TERM,
      edits: HOUSE_EDITS_TERM,
    },
    wants: piece.brief?.wants ?? [],
    avoid: piece.brief?.avoid ?? '',
    rate: piece.brief?.rate ?? '',
    commissionedBy: piece.brief?.commissionedBy ?? '',
    commissionedOn: piece.brief?.commissionedOn ?? '',
  };
}

/**
 * Human label for a pitch's triage `status`, plus the editor's `passNote`
 * when passed (spec §7.6 design: `Passed: "not now", Marta replied
 * personally`), the ONLY editor-authored text surfaced to the writer here,
 * since a pass note is written to be read by the pitcher.
 *
 * ENGLISH, and it welds the platform's half onto the editor's own words, so a
 * client cannot translate one without touching the other. `status` and
 * `passNote` ship the two halves apart for exactly that reason. Like
 * `stageToWriterState`, this stays only as `state`'s fallback value.
 */
function pitchStatusToWriterState(pitch: MagazinePitch): string {
  switch (pitch.status) {
    case 'waiting':
      return 'Waiting to hear back';
    case 'maybe':
      return 'Held for consideration';
    case 'passed':
      return pitch.passNote ? `Passed: ${pitch.passNote}` : 'Passed';
    case 'commissioned':
      return 'Commissioned';
  }
}

function pitchStatusToTone(status: PitchStatus): 'hold' | 'no' | 'live' {
  if (status === 'maybe') {
    return 'hold';
  }
  if (status === 'passed') {
    return 'no';
  }
  return 'live';
}

export function toWriterPitch(pitch: MagazinePitch): WriterPitchResponse {
  return {
    id: pitch.id,
    title: pitch.title,
    sent: pitch.createdAt.toISOString(),
    state: pitchStatusToWriterState(pitch),
    status: pitch.status,
    // Gated on `passed` on purpose: `triagePitch` writes `passNote` only on a
    // pass and leaves it alone when a pitch is later moved to `maybe`, so the
    // column can outlive the verdict that produced it.
    passNote: pitch.status === 'passed' ? pitch.passNote : null,
    tone: pitchStatusToTone(pitch.status),
  };
}

/**
 * Human label for a payment's `status`, folding in `dueOn`/`paidOn` (spec
 * §7.6 design: "Paid 14 Jun" / "Due 19 Aug"). `payment === null` means the
 * piece hasn't had a payment row agreed yet. Dates go through
 * `writerFacingDate`, since the whole point of this sentence is that a writer
 * can read it.
 *
 * ENGLISH, so the same caveat as the two mappers above applies: `status`,
 * `dueOn` and `paidOn` carry the same facts unformatted, and the writer
 * workspace now composes its own translated wording from them.
 */
function paymentStatusToWriterState(payment: MagazinePayment | null): string {
  if (payment === null) {
    return 'Not yet agreed';
  }

  const status: PaymentStatus = payment.status;
  if (status === 'paid') {
    return payment.paidOn ? `Paid ${writerFacingDate(payment.paidOn)}` : 'Paid';
  }
  if (status === 'approved_unpaid') {
    return payment.dueOn
      ? `Approved, unpaid: due ${writerFacingDate(payment.dueOn)}`
      : 'Approved, unpaid';
  }
  return payment.dueOn
    ? `Agreed: due ${writerFacingDate(payment.dueOn)}`
    : 'Agreed';
}

/**
 * One row of the writer's payments tab.
 *
 * `issue` is the issue's DISPLAY number, which the caller has to supply:
 * `MagazinePiece` carries only `issueId`, and this mapper has no repository.
 * It defaults to `null` so a caller that has not loaded the issue yet degrades
 * to "unscheduled" wording rather than doing what this used to do, which was
 * print the raw UUID at the writer.
 */
export function toWriterPayment(
  piece: MagazinePiece,
  payment: MagazinePayment | null,
  issue: WriterPaymentIssue | null = null,
): WriterPaymentResponse {
  return {
    title: piece.title,
    issue: issue?.number ?? null,
    issueId: piece.issueId,
    issueTitle: issue?.title ?? null,
    fee: writerFacingFee(payment),
    state: paymentStatusToWriterState(payment),
    status: payment?.status ?? null,
    dueOn: payment?.dueOn ?? null,
    paidOn: payment?.paidOn ?? null,
  };
}

/**
 * The article draft as its WRITER is allowed to read it (PRD-122a).
 *
 * Until this existed the writer workspace could only push text at the desk:
 * assignments, pitches, payments, byline, file and messages, and nothing that
 * read the draft back. So the house term printed on every assignment ("you see
 * them before they ship") was false, and a writer had no way to revise the
 * version their editor had actually worked on.
 *
 * Deliberately a NARROWER projection than the editor's `ArticleDraftResponse`:
 * the body, the headline and the standfirst are the writer's own work, while
 * the SEO/social/canonical/hero fields are desk furniture the writer neither
 * sets nor needs. Same rule as the rest of this file.
 */
export interface WriterDraftResponse {
  pieceId: string;
  /** `false` when the piece has no article row yet, so nothing has been
   *  drafted or filed. `blocks` is then empty and `version` is `0`, which is
   *  the base version the row will be created at when the writer files. */
  hasDraft: boolean;
  stage: PieceStage;
  title: string;
  standfirst: string;
  blocks: ArticleBlock[];
  /** Live word count of `blocks`, so the writer reads the same number the desk
   *  does rather than counting by hand. */
  words: number;
  /** `brief.wordCount`, the commissioned target. */
  target: number | null;
  /** `brief.filedWords`: what the last filing recorded, which can lag `words`
   *  once an editor has cut or added since. */
  filedWords: number | null;
  /**
   * Optimistic-concurrency counter (`MagazineArticle.version`). Send it back as
   * `FileDraftDto.expectedVersion` when filing: the same 409 the editor's
   * autosave gets is what stops a writer's filing from landing on top of an
   * edit they never saw.
   */
  version: number;
  /** ISO instant the draft row was last written, or `null` with no draft. */
  updatedAt: string | null;
  /** ISO instant the article went (or goes) live, or `null` while it is a
   *  draft. A future value means scheduled. */
  publishedAt: string | null;
}

export function toWriterDraft(
  piece: MagazinePiece,
  article: MagazineArticle | null,
): WriterDraftResponse {
  const blocks = article === null ? [] : toReadableBlocks(article.blocks);
  return {
    pieceId: piece.id,
    hasDraft: article !== null,
    stage: piece.stage,
    title: article?.title ?? piece.title,
    standfirst: article?.standfirst ?? '',
    blocks,
    words: countArticleWords(blocks),
    target: piece.brief?.wordCount ?? null,
    filedWords: piece.brief?.filedWords ?? null,
    version: article?.version ?? 0,
    updatedAt: article?.updatedAt?.toISOString() ?? null,
    publishedAt: article?.publishedAt?.toISOString() ?? null,
  };
}
