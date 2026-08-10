import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * String-union "enums" stored as `varchar` (repo idiom: no Postgres
 * `CREATE TYPE`, see `MagazineDeck.publishedAt` precedent). `format` is the
 * output kind a piece will become; `stage` is the workflow position on the
 * editor desk.
 */
export type PieceFormat = 'article' | 'deck';

/**
 * Piece-level art status shown on the desk's `v-art` saved view and the
 * NeedsStrip (Magazine Desk Phase 7, Task A3). Distinct from
 * `PieceBrief.art` (a free-text note captured at commission time) — this is
 * the tracked workflow state. `'na'` means the piece needs no art (e.g. a
 * text-only column).
 */
export type ArtState = 'none' | 'brief' | 'in' | 'na';

export type PieceStage =
  | 'commissioned'
  | 'drafting'
  | 'in_review'
  | 'edit'
  | 'sensitivity_read'
  | 'layout'
  | 'ready';

/**
 * jsonb shape stored on `MagazinePiece.brief`. Validated by hand-written
 * guards (`piece-jsonb.validation.ts`), never by the ORM or TypeORM
 * decorators.
 */
export interface PieceBrief {
  angle: string;
  wants: string[];
  avoid: string;
  wordCount: number | null;
  filedWords: number | null;
  rate: string;
  killFee: string;
  commissionedBy: string;
  commissionedOn: string;
  art: string;
}

/**
 * One subject entry inside `PieceCare.subjects` — a person named or
 * discussed in the piece who needs consent/sensitivity tracking.
 */
export interface PieceCareSubject {
  name: string;
  named: boolean;
  out: boolean | null;
  consent: 'given' | 'pending' | 'pseudonym';
  reply: string;
  note: string;
}

/**
 * jsonb shape stored on `MagazinePiece.care`. Validated by hand-written
 * guards (`piece-jsonb.validation.ts`), never by the ORM or TypeORM
 * decorators. The publish gate reads unsettled consent + an incomplete
 * sensitivity read off this shape.
 */
export interface PieceCare {
  subjects: PieceCareSubject[];
  contentNotes: string[];
  flags: { key: string; on: boolean; note: string }[];
  read: {
    readerId?: string;
    reader: string;
    role: string;
    status: string;
    askedOn: string;
    dueOn: string;
    checks: { label: string; done: boolean }[];
  } | null;
}

/**
 * The commission/workflow spine of the editor desk (spec §3.1). One row per
 * commissioned piece, tracked through `stage` from commission to ready.
 * `late`/`waitingOn` are derived in the response mapper, never stored here.
 */
@Entity('magazine_piece')
export class MagazinePiece {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  format!: PieceFormat;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar' })
  section!: string;

  @Column({ type: 'varchar', nullable: true })
  kind!: string | null;

  @Column({ type: 'varchar', default: 'commissioned' })
  stage!: PieceStage;

  @Index('IDX_magazine_piece_editor')
  @Column({ type: 'uuid' })
  editorId!: string;

  @Index('IDX_magazine_piece_writer')
  @Column({ type: 'uuid', nullable: true })
  writerId!: string | null;

  @Column({ type: 'varchar', default: '' })
  byline!: string;

  @Column({ type: 'date', nullable: true })
  dueOn!: string | null;

  @Index('IDX_magazine_piece_issue')
  @Column({ type: 'uuid', nullable: true })
  issueId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  articleId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  deckId!: string | null;

  @Column({ type: 'int', nullable: true })
  wordTarget!: number | null;

  @Column({ type: 'int', nullable: true })
  slideTarget!: number | null;

  @Column({ type: 'boolean', default: false })
  fresh!: boolean;

  @Column({ type: 'uuid', nullable: true })
  pitchId!: string | null;

  @Column({ type: 'int', nullable: true })
  orderIndex!: number | null;

  @Column({ type: 'varchar', nullable: true })
  pages!: string | null;

  @Column({ type: 'boolean', default: false })
  laidOut!: boolean;

  /** Art-workflow status (Magazine Desk Phase 7, Task A3); see `ArtState`. */
  @Column({ type: 'varchar', default: 'none' })
  art!: ArtState;

  /**
   * The members'-digest-style blurb for this piece, edited directly on the
   * issue's Cover & Contents tab (Magazine Desk Phase 7, Task B2). Distinct
   * from `IssueDigestItem.blurb` (the issue's own digest jsonb) — this is
   * the per-piece source text, persisted independently of any one issue.
   */
  @Column({ type: 'varchar', default: '' })
  contentsBlurb!: string;

  @Column({ type: 'jsonb', nullable: true })
  brief!: PieceBrief | null;

  @Column({ type: 'jsonb', nullable: true })
  care!: PieceCare | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
