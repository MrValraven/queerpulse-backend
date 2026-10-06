import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The structured half of a funding thread: one row per open call
 * (`forum_thread.kind = 'call'`) or fundraiser (`kind = 'ask'`), keyed by the
 * thread id. A thread with no row behaves exactly as it always did.
 *
 * The kind lives on `forum_thread` and is not repeated here, so
 * `ForumFundingService` validates the pairing on every write and the CHECK
 * constraints in `CreateForumThreadFunding1828600000000` keep the call-only and
 * ask-only columns from ever both holding values.
 *
 * No relation decorators, matching `ForumPoll`: the migration owns the foreign
 * key (`FK_forum_thread_funding_thread_id`, ON DELETE CASCADE).
 */
@Entity('forum_thread_funding')
export class ForumThreadFunding {
  @PrimaryColumn({ type: 'uuid' })
  threadId!: string;

  // What a member opens: the funder's call page or the crowdfunding page. Always
  // https; stored as parsed and re-serialised by `normalizeFundingLink`.
  @Column({ type: 'varchar', length: 2048 })
  linkUrl!: string;

  // Host without `www.` plus path without trailing slash, then the query
  // parameters that are not tracking ones, sorted; the fragment is dropped.
  // Backs the duplicate lookup (`GET /forum/funding/lookup`).
  @Index('IDX_forum_thread_funding_link_key')
  @Column({ type: 'varchar', length: 512 })
  linkKey!: string;

  // Set on insert and on every funding-field edit by the service. A plain
  // column on purpose: an UpdateDateColumn would also move on writes that are
  // not edits (ending an ask, an approval), and a rolling call reads `stale`
  // from this.
  @Column({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;

  // --- call ---------------------------------------------------------------
  @Column({ type: 'varchar', length: 120, nullable: true })
  funderName!: string | null;

  // Whole euros.
  @Column({ type: 'int', nullable: true })
  amountMin!: number | null;

  @Column({ type: 'int', nullable: true })
  amountMax!: number | null;

  // NULL means a rolling call. Partial index `IDX_forum_thread_funding_deadline`
  // (migration only) serves the closing view and the reminder sweep.
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  deadline!: Date | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  eligibility!: string[];

  @Column({ type: 'varchar', length: 16, nullable: true })
  scope!: string | null;

  // --- ask ----------------------------------------------------------------
  @Column({ type: 'int', nullable: true })
  goalAmount!: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  askPurpose!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  beneficiary!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  endsAt!: Date | null;

  // Set when the author marks the ask ended (`POST .../funding/end`).
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  endedAt!: Date | null;

  // `goal_reached` or `closed`.
  @Column({ type: 'varchar', length: 16, nullable: true })
  endedReason!: string | null;

  // Set when a moderator approves the ask and cleared when an author edit
  // sends it back to review. Backs "Checked by moderators on {{date}}" and the
  // 90-day auto-end.
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  approvedAt!: Date | null;
}
