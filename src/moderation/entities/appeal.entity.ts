import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ReportSeverity } from '../../reports/entities/report.entity';

// Mirrors the frontend's `AppealDTO['status']`
// (`queerpulse/src/features/admin/api/moderation.api.ts`) — `Open` renamed
// to `Awaiting` (I8).
export enum AppealStatus {
  Awaiting = 'awaiting',
  Upheld = 'upheld',
  Overturned = 'overturned',
}

/**
 * A member's appeal of a moderation decision. `reportId` is nullable — an
 * appeal may reference a report that's since been deleted.
 *
 * `actionId`/`appellantId`/`severity`/`community` support the enriched
 * `AppealDTO` (`moderation.api.ts`) the appeals queue renders. They stay
 * nullable/best-effort: `POST /appeals` (`AppealsController`) resolves the
 * appealed action where it can, but a cold appeal with no resolvable action is
 * still valid — `moderation-response.ts` documents the read-time fallbacks.
 *
 * The two partial unique indexes enforce "one OPEN appeal per member per
 * action" behind `ModerationService.submitAppeal`'s check-then-insert (they
 * are what actually closes the race). `UQ_appeals_open_appellant_action` covers
 * appeals linked to a resolved action; `UQ_appeals_open_appellant_no_action`
 * covers cold appeals (NULL `action_id`, which a plain composite unique index
 * would treat as always-distinct). Both are created by
 * `1785003500000-AddAppealsOpenDedupeIndex`; the decorators keep entity
 * metadata in step for any future `migration:generate` diff.
 */
@Entity('appeals')
@Index('UQ_appeals_open_appellant_action', ['appellantId', 'actionId'], {
  unique: true,
  where: `"status" = 'awaiting'`,
})
@Index('UQ_appeals_open_appellant_no_action', ['appellantId'], {
  unique: true,
  where: `"status" = 'awaiting' AND "action_id" IS NULL`,
})
export class Appeal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_appeals_report_id')
  @Column({ type: 'uuid', nullable: true })
  reportId!: string | null;

  // The specific moderator action (a `mod_audit_logs` row) being appealed.
  @Index('IDX_appeals_action_id')
  @Column({ type: 'uuid', nullable: true })
  actionId!: string | null;

  // The member filing the appeal.
  @Index('IDX_appeals_appellant_id')
  @Column({ type: 'uuid', nullable: true })
  appellantId!: string | null;

  // Denormalized from the linked report at filing time, for queue
  // sorting/filtering without a join.
  @Column({
    type: 'enum',
    enum: ReportSeverity,
    enumName: 'reports_severity_enum',
    default: ReportSeverity.Medium,
  })
  severity!: ReportSeverity;

  @Column({ type: 'varchar', nullable: true })
  community!: string | null;

  // The member's appeal text — renamed from `body` (I8).
  @Column({ type: 'text' })
  argument!: string;

  @Index('IDX_appeals_status')
  @Column({
    type: 'enum',
    enum: AppealStatus,
    enumName: 'appeals_status_enum',
    default: AppealStatus.Awaiting,
  })
  status!: AppealStatus;

  @Column({ type: 'text', nullable: true })
  decision!: string | null;

  /**
   * When this appeal must be decided by, computed at filing from the published
   * 7-day window in `../appeal-window.ts`. TS-11.
   *
   * Millisecond precision, and for exactly the reason `reports.sla_due_at`
   * carries it: the awaiting queue pages on this raw column through
   * `cursorPaginate`'s alternate-keyset path, and that path compares a
   * millisecond-resolution JS `Date` cursor against the stored value. A
   * microsecond tail would re-serve the boundary row on the next page. See
   * `1793520300000-NarrowReportCursorPrecision.ts` for the full write-up.
   *
   * NOT NULL: `1794920000000-AddAppealDecisionWindows` backfills every existing
   * row with `created_at + 7 days` (the published window, applied
   * retroactively) precisely so the keyset never meets a NULL, which the tuple
   * comparison would silently drop from every page.
   */
  @Column({ type: 'timestamptz', precision: 3 })
  slaDueAt!: Date;

  /**
   * When a moderator upheld or overturned this appeal. NULL means still
   * awaiting, and is the only thing that makes the published 7-day promise
   * measurable at all: before this column, `status` said whether an appeal was
   * decided and nothing said when, so the transparency report had to attribute
   * appeal outcomes to the period the appeal was FILED in
   * (`transparency.service.ts` says so on the page).
   *
   * Deliberately NOT backfilled. An appeal decided before this column existed
   * has no recoverable decision timestamp, and reconstructing one from
   * `mod_audit_logs` would silently miss every cold appeal (no `reportId` means
   * no `appeal_upheld`/`appeal_overturned` row). A decided appeal with a NULL
   * `decidedAt` is "decided, time unrecorded", which is the truth.
   */
  @Index('IDX_appeals_decided_at')
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt!: Date | null;

  // Millisecond precision, same argument as `slaDueAt` above: the DECIDED tab
  // pages on the default `(created_at, id) DESC` keyset, and `cursorPaginate`
  // can only use the raw column (rather than a non-indexable `date_trunc`
  // wrapper) once the column itself is `timestamptz(3)`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
