import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  VerificationEventAction,
  VerificationLevel,
} from '../verification-level';

/**
 * Append-only audit row: one per change to a member's verification standing
 * (submitted, approved, rejected, overridden, downgraded, appealed,
 * withdrawn). Rows are never updated or deleted, so this table is the single
 * source of truth for "who changed what, and why" behind the admin drawer's
 * history panel.
 */
@Entity('verification_events')
@Index(['userId', 'createdAt'])
export class VerificationEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid', nullable: true })
  requestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({
    type: 'enum',
    enum: VerificationEventAction,
    enumName: 'verification_event_action_enum',
  })
  action!: VerificationEventAction;

  @Column({
    type: 'enum',
    enum: VerificationLevel,
    enumName: 'member_verification_level_enum',
    nullable: true,
  })
  fromLevel!: VerificationLevel | null;

  @Column({
    type: 'enum',
    enum: VerificationLevel,
    enumName: 'member_verification_level_enum',
    nullable: true,
  })
  toLevel!: VerificationLevel | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  signals!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
