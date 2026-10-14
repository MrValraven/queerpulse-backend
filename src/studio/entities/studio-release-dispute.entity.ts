import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioRelease } from './studio-release.entity';

export enum StudioReleaseDisputeStatus {
  Open = 'open',
  Upheld = 'upheld',
  Rejected = 'rejected',
}

/** The two ways staff decide an open dispute. */
export type StudioReleaseDisputeDecision =
  StudioReleaseDisputeStatus.Upheld | StudioReleaseDisputeStatus.Rejected;

/**
 * An artist's dispute about a taken-down Studio release (open demo pages,
 * `QUEERPULSE-STUDIO-OPEN-DEMO-PAGES-DESIGN-2026-10-13.md`, section 5.1).
 *
 * THE ROW NAMES NO MEMBER. Ownership of the release's persona is checked
 * when the dispute is filed and written down nowhere, so staff reading this
 * table can never learn which member stands behind a persona. The deciding
 * staff member is kept (`decided_by_id`), set null when that account goes.
 *
 * One open dispute per release (`UQ_studio_release_disputes_open_release`),
 * at most `STUDIO_LIMITS.disputesPerRelease` over the release's life
 * (checked under the release row lock). `release_id` cascades on update, so
 * a persona unlink that re-keys the release carries its disputes along.
 * `created_at` holds milliseconds: it is the staff list's keyset cursor.
 * Migration `1831700100000-AddStudioReleaseDisputes`.
 */
@Entity('studio_release_disputes')
@Index('UQ_studio_release_disputes_open_release', ['releaseId'], {
  unique: true,
  where: `"status" = 'open'`,
})
@Index('IDX_studio_release_disputes_release_created_at', [
  'releaseId',
  'createdAt',
  'id',
])
@Index('IDX_studio_release_disputes_status_created_at', [
  'status',
  'createdAt',
  'id',
])
@Check(
  'CHK_studio_release_disputes_decision',
  `("status" = 'open' AND "decided_at" IS NULL AND "staff_reply" IS NULL)
    OR ("status" <> 'open' AND "decided_at" IS NOT NULL AND "staff_reply" IS NOT NULL)`,
)
export class StudioReleaseDispute {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_release_disputes',
  })
  id!: string;

  @Column({ type: 'uuid' })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_release_disputes_release',
  })
  release?: StudioRelease;

  /** The artist's note to our team. */
  @Column({ type: 'varchar', length: 1000 })
  note!: string;

  @Column({
    type: 'enum',
    enum: StudioReleaseDisputeStatus,
    enumName: 'studio_release_disputes_status_enum',
    default: StudioReleaseDisputeStatus.Open,
  })
  status!: StudioReleaseDisputeStatus;

  /** Staff's reply, which the release's owners read on the release page. */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  staffReply!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'decided_by_id',
    foreignKeyConstraintName: 'FK_studio_release_disputes_decided_by',
  })
  decidedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;
}
