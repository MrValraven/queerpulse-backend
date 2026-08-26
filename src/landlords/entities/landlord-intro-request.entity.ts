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

export enum LandlordIntroRequestStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

/**
 * A stored "request an introduction" against a landlord, actioned by the
 * moderator/facilitator team (a landlord isn't a member, so there is no inbox
 * delivery). Mirrors the co-ops `coop_join_requests` pattern.
 */
@Entity('landlord_intro_requests')
export class LandlordIntroRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_landlord_intro_requests_landlord_id')
  @Column({ type: 'uuid' })
  landlordId!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL (see
  // `1785600300000-AddUserRefForeignKeys`): an account-erasure hard-delete nulls
  // the requester out while the intro request survives. Relation kept alongside
  // the scalar so metadata and schema agree.
  @Index('IDX_landlord_intro_requests_user_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', nullable: true })
  contactEmail!: string | null;

  @Index('IDX_landlord_intro_requests_status')
  @Column({
    type: 'enum',
    enum: LandlordIntroRequestStatus,
    enumName: 'landlord_intro_requests_status_enum',
    default: LandlordIntroRequestStatus.Pending,
  })
  status!: LandlordIntroRequestStatus;

  // The triage decision's audit trail (LOC-19). A member asked to be put in
  // touch with a landlord and, until now, the only record of the answer was
  // the row's own `status` — no who, no when, no why, and the member was never
  // told at all. `decisionReason` is REQUIRED by the service on a decline and
  // is the text the requester reads.
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
