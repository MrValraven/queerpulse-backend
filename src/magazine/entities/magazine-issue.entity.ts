import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Run-order entry for the issue-production page (Magazine Desk Phase 5):
 * which piece runs in this slot and its planned page range. Order in the
 * array IS the running order; resolved against `magazine_piece` by
 * `pieceId` in the service layer.
 */
export interface IssueRunOrderItem {
  pieceId: string;
  pages: string;
}

/**
 * Members' digest entry for the issue-production page (Magazine Desk
 * Phase 5): the editorial blurb for a piece and whether it is included
 * (`on`) in the digest/social send.
 */
export interface IssueDigestItem {
  pieceId: string;
  blurb: string;
  on: boolean;
}

/**
 * One piece a ship declined to publish, and why (ENG-110). `reasons` are
 * already human-readable sentences, because the ship report is read by an
 * editor on the production page and nothing downstream branches on them.
 */
export interface IssueShipHeldPiece {
  pieceId: string;
  title: string;
  reasons: string[];
}

/**
 * What the most recent `shipIssue` actually did (PRD-126 / ENG-110), stored on
 * the issue so a reload still shows it. Before this the ship reported nothing:
 * pieces it silently skipped looked identical to pieces it published, and an
 * editor had no way to see that half the issue had held back.
 *
 * `shippedAt` is when the click happened; `publishAt` is when the pieces go
 * live, which is 09:00 Europe/Lisbon on the issue date for a future issue and
 * equal to `shippedAt` for an immediate ship. Both are ISO instants: jsonb has
 * no date type, and TypeORM would hand a `Date` back as a string anyway.
 */
export interface IssueLastShip {
  shippedAt: string;
  publishAt: string;
  publishedPieceIds: string[];
  held: IssueShipHeldPiece[];
}

/**
 * A quarterly print/digital issue (`IssuesPage.tsx`'s `ISSUES` array). `number`
 * is the zero-padded display number ("01".."09") the FE links to — it acts as
 * the public identifier (`GET /magazine/issues/:number`), not `id`.
 */
@Entity('magazine_issue')
export class MagazineIssue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_magazine_issue_number', { unique: true })
  @Column({ type: 'varchar' })
  number!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  dek!: string;

  // Postgres `date` — TypeORM returns this as a plain `YYYY-MM-DD` string,
  // matching `IssueResponse.publishedOn` with no extra conversion. NULL until
  // an issue is scheduled: the desk opens a number first and picks the date
  // later, and `shipIssue` stamps today's date if nobody ever did.
  @Column({ type: 'date', nullable: true })
  publishedOn!: string | null;

  /**
   * PRD-106 — the last day the desk accepts pitches for this issue, as a
   * Postgres `date` (`YYYY-MM-DD`, same handling as `publishedOn`). NULL by
   * default and NULL for most issues: an editor sets it when they want one,
   * and the public submit-story form prints the deadline line only when a
   * real date is stored. Before this column the form quoted a hardcoded
   * "15 August 2026" that went stale and stayed stale.
   */
  @Column({ type: 'date', nullable: true })
  submissionDeadline!: string | null;

  @Column({ type: 'varchar', nullable: true })
  coverUrl!: string | null;

  /** "Issue N · theme" on the production header (Magazine Desk Phase 5). */
  @Column({ type: 'varchar', default: '' })
  theme!: string;

  /** Running order for issue production (Magazine Desk Phase 5). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  runOrder!: IssueRunOrderItem[];

  /** Members' digest / social curation (Magazine Desk Phase 5). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  digest!: IssueDigestItem[];

  /** Cover coverlines (Magazine Desk Phase 5) — distinct from headlines. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  coverlines!: string[];

  /**
   * CNT-6 "Schedule with issue": whether the members' digest should go out
   * automatically to every confirmed newsletter subscriber the moment this
   * issue ships (there is no cron in this module — "schedule" gates the
   * real ship action instead, see `MagazinePieceService.shipIssue`).
   */
  @Column({ type: 'boolean', default: false })
  digestSendOnPublish!: boolean;

  /**
   * Set once the digest has actually gone out for this issue (CNT-6);
   * `null` until then. The idempotency guard on `shipIssue` — a re-ship
   * never re-sends once this is stamped.
   */
  @Column({ type: 'timestamptz', nullable: true })
  digestSentAt!: Date | null;

  /**
   * The report from the most recent ship (ENG-110); NULL on an issue that has
   * never shipped. Nullable rather than defaulting to an empty object so
   * "never shipped" and "shipped and published nothing" stay distinguishable.
   */
  @Column({ type: 'jsonb', nullable: true })
  lastShip!: IssueLastShip | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
