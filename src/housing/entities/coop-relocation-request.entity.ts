import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { HousingCoop } from './housing-coop.entity';

export enum RelocationRequestStatus {
  Open = 'open',
  Resolved = 'resolved',
  Dismissed = 'dismissed',
}

/**
 * A co-living conflict-resolution / relocation request. Research: co-living
 * operators resolve serious roommate conflict by relocation rather than
 * mediation-forever. A member flags a serious household conflict; an operator or
 * steward logs the relocation `outcome` and marks it resolved. Deliberately
 * lightweight — one row, a free-text situation, and an outcome log.
 */
@Entity('coop_relocation_requests')
export class CoopRelocationRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_coop_relocation_requests_coop_id')
  @Column({ type: 'uuid' })
  coopId!: string;

  @ManyToOne(() => HousingCoop, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coop_id' })
  coop!: HousingCoop;

  @Column({ type: 'varchar' })
  name!: string;

  /** The member's description of the serious household conflict. */
  @Column({ type: 'text' })
  situation!: string;

  // The member who flagged it, when signed in. FK ON DELETE SET NULL so an
  // account erasure preserves the operator's audit trail.
  @Index('IDX_coop_relocation_requests_user_id')
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({
    type: 'enum',
    enum: RelocationRequestStatus,
    enumName: 'coop_relocation_requests_status_enum',
    default: RelocationRequestStatus.Open,
  })
  status!: RelocationRequestStatus;

  /** The relocation outcome an operator/steward logs when resolving. */
  @Column({ type: 'text', nullable: true })
  outcome!: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
