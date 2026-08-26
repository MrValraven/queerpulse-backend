import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { QueueAssignmentColumns } from '../../common/queue-assignment.columns';
import { User } from '../../users/entities/user.entity';
import { VerificationLevel, VerificationType } from '../verification-level';
import { VerificationRequestStatus } from '../verification-request-status';

/**
 * One row per member-submitted verification request — the row the review
 * queue reads from. `status` walks the state machine in
 * `verification-request-status.ts` (enforced server-side, never trusted from
 * the client); an approval raises the member's `member_verifications` row
 * and writes a matching `verification_events` row, but this table is the
 * request's own record independent of that current-level store.
 */
@Entity('verification_requests')
@Index(['status', 'type'])
@Index(['userId'])
// OPS-04: backs the queue's "Assigned to me" filter
// (`listRequestsForAdmin`'s `assignedTo` narrowing), which is a plain equality
// on this column. Declared here rather than on `QueueAssignmentColumns`
// because an index name is global in Postgres and a name on the shared base
// would collide across the tables that extend it.
@Index('IDX_verification_requests_assigned_staff_id', ['assignedStaffId'])
export class VerificationRequest extends QueueAssignmentColumns {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    type: 'enum',
    enum: VerificationType,
    enumName: 'verification_type_enum',
    default: VerificationType.Identity,
  })
  type!: VerificationType;

  @Column({
    type: 'enum',
    enum: VerificationLevel,
    enumName: 'member_verification_level_enum',
  })
  requestedLevel!: VerificationLevel;

  @Column({
    type: 'enum',
    enum: VerificationRequestStatus,
    enumName: 'verification_request_status_enum',
    default: VerificationRequestStatus.Pending,
  })
  status!: VerificationRequestStatus;

  @Column({ type: 'text', nullable: true })
  context!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  evidenceRef!: string | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by_user_id' })
  reviewedBy!: User | null;

  @Column({ type: 'jsonb', nullable: true })
  signals!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  isAppeal!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
