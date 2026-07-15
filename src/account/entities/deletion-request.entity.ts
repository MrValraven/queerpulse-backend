import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Mirrors the frontend's `DeletionStatus` in
// `features/settings/api/account.api.ts` ('grace' | 'processing' | 'erased'),
// plus an internal `cancelled` state that is never surfaced on the wire (a
// cancelled request simply stops being "the" active one — `GET
// /account/deletion-request` returns `null` once cancelled). Only the most
// recent `Grace`/`Processing` row (if any) is "the" active request for a user.
export enum DeletionRequestStatus {
  Grace = 'grace',
  Processing = 'processing',
  Erased = 'erased',
  Cancelled = 'cancelled',
}

@Entity('deletion_request')
export class DeletionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_deletion_request_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: DeletionRequestStatus,
    enumName: 'deletion_request_status_enum',
  })
  status: DeletionRequestStatus;

  @Column({ type: 'timestamptz' })
  scheduledFor: Date;

  @Column({ type: 'varchar', nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
