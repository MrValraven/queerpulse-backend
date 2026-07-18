import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserStatus } from '../../users/entities/user.entity';

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

  // When the erasure sweep actually erased the account — distinct from
  // `scheduledFor` (when it *became* due). Stamped by
  // `AccountDeletionProcessorService` alongside `status = Erased`, and left
  // NULL on `Grace`/`Cancelled` rows. NOTE: this row outlives the `users` row
  // it points at — the FK was dropped in
  // `AddDeletionErasureSupport1782800700000` precisely so the erasure ledger
  // survives the erasure.
  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  /**
   * The `users.status` held when the grace period opened. Opening a deletion
   * request sets `users.status = Deactivated` — that is what makes the
   * "everything is hidden now" line in the delete-account UI true rather than
   * aspirational — so cancelling has to know what to put back.
   *
   * Same security reasoning as `AccountDeactivation.previousStatus`: a
   * suspended member can reach `POST /account/deletion-request` (the account
   * controller is JWT-only by design), and cancelling must return them to
   * `Suspended`, never to `Active`.
   *
   * Left NULL on rows that predate the column (the migration backfills open
   * `grace` rows from `users.status`) and irrelevant once `status = 'erased'`,
   * since the user row it describes is gone by then.
   */
  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'users_status_enum',
    nullable: true,
  })
  previousStatus: UserStatus | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
