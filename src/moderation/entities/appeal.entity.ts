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
 * `AppealDTO` (`moderation.api.ts`) the appeals queue renders. There is no
 * `POST /appeals` endpoint in this module yet (out of scope here — appeals
 * are read/reviewed, not created, by the current contract), so these columns
 * are nullable/best-effort until a creation flow lands; `moderation-response.ts`
 * documents the read-time fallbacks.
 */
@Entity('appeals')
export class Appeal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_appeals_report_id')
  @Column({ type: 'uuid', nullable: true })
  reportId: string | null;

  // The specific moderator action (a `mod_audit_logs` row) being appealed.
  @Index('IDX_appeals_action_id')
  @Column({ type: 'uuid', nullable: true })
  actionId: string | null;

  // The member filing the appeal.
  @Index('IDX_appeals_appellant_id')
  @Column({ type: 'uuid', nullable: true })
  appellantId: string | null;

  // Denormalized from the linked report at filing time, for queue
  // sorting/filtering without a join.
  @Column({
    type: 'enum',
    enum: ReportSeverity,
    enumName: 'reports_severity_enum',
    default: ReportSeverity.Medium,
  })
  severity: ReportSeverity;

  @Column({ type: 'varchar', nullable: true })
  community: string | null;

  // The member's appeal text — renamed from `body` (I8).
  @Column({ type: 'text' })
  argument: string;

  @Index('IDX_appeals_status')
  @Column({
    type: 'enum',
    enum: AppealStatus,
    enumName: 'appeals_status_enum',
    default: AppealStatus.Awaiting,
  })
  status: AppealStatus;

  @Column({ type: 'text', nullable: true })
  decision: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
