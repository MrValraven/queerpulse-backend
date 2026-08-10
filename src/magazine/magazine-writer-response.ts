import { MagazinePiece, PieceStage } from './entities/magazine-piece.entity';
import { MagazinePitch, PitchStatus } from './entities/magazine-pitch.entity';
import {
  MagazinePayment,
  PaymentStatus,
} from './entities/magazine-payment.entity';

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
  state: string;
  stage: PieceStage;
  words: number | null;
  target: number | null;
  fee: string;
  pay: string;
  note: string;
  byline: string;
  terms: WriterAssignmentTerms;
}

/** Static house terms shared by every commission (see `WriterAssignmentTerms`). */
const HOUSE_RIGHTS_TERM = 'first publication, you keep the rest';
const HOUSE_EDITS_TERM = 'you see them before they ship';

export interface WriterPitchResponse {
  id: string;
  title: string;
  sent: string;
  state: string;
  tone: 'hold' | 'no' | 'live';
}

export interface WriterPaymentResponse {
  title: string;
  issue: string | null;
  fee: string;
  state: string;
}

/**
 * Human label for a piece's `stage`, from the writer's point of view (spec
 * §7.6 design `mag-contrib.jsx`: "With your editor" for `edit`, etc.) — a
 * different vocabulary from any editor-facing label, so it is NOT shared
 * with `magazine-piece-response.ts`.
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
  }
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
    fee: payment?.fee ?? '',
    pay: payment?.status ?? 'agreed',
    note: piece.brief?.angle ?? '',
    byline: piece.byline,
    terms: {
      killFee: piece.brief?.killFee ?? '',
      rights: HOUSE_RIGHTS_TERM,
      edits: HOUSE_EDITS_TERM,
    },
  };
}

/**
 * Human label for a pitch's triage `status`, plus the editor's `passNote`
 * when passed (spec §7.6 design: "Passed — 'not now', Marta replied
 * personally") — the ONLY editor-authored text surfaced to the writer here,
 * since a pass note is written to be read by the pitcher.
 */
function pitchStatusToWriterState(pitch: MagazinePitch): string {
  switch (pitch.status) {
    case 'waiting':
      return 'Waiting to hear back';
    case 'maybe':
      return 'Held for consideration';
    case 'passed':
      return pitch.passNote ? `Passed — ${pitch.passNote}` : 'Passed';
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
    tone: pitchStatusToTone(pitch.status),
  };
}

/**
 * Human label for a payment's `status`, folding in `dueOn`/`paidOn` (spec
 * §7.6 design: "Paid 14 Jun" / "Due 19 Aug"). `payment === null` means the
 * piece hasn't had a payment row agreed yet.
 */
function paymentStatusToWriterState(payment: MagazinePayment | null): string {
  if (payment === null) {
    return 'Not yet agreed';
  }

  const status: PaymentStatus = payment.status;
  if (status === 'paid') {
    return payment.paidOn ? `Paid ${payment.paidOn}` : 'Paid';
  }
  if (status === 'approved_unpaid') {
    return payment.dueOn
      ? `Approved, unpaid — due ${payment.dueOn}`
      : 'Approved, unpaid';
  }
  return payment.dueOn ? `Agreed — due ${payment.dueOn}` : 'Agreed';
}

export function toWriterPayment(
  piece: MagazinePiece,
  payment: MagazinePayment | null,
): WriterPaymentResponse {
  return {
    title: piece.title,
    issue: piece.issueId,
    fee: payment?.fee ?? '',
    state: paymentStatusToWriterState(payment),
  };
}
