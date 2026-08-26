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

// At most one OPEN (`grace`/`processing`) request per member — a partial unique
// index, created by `AddDeletionRequestOpenUniqueIndex1793500200000`. Without
// it two concurrent `POST /account/deletion-request` calls both inserted a
// `grace` row and cancelling only cleared one, leaving the member to be erased
// 30 days after they cancelled. `AccountService.requestDeletion` maps the 23505
// to the same 409 its in-transaction pre-check raises.
@Index('UQ_deletion_request_open_user', ['userId'], {
  unique: true,
  where: `"status" IN ('grace', 'processing')`,
})
@Entity('deletion_request')
export class DeletionRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_deletion_request_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: DeletionRequestStatus,
    enumName: 'deletion_request_status_enum',
  })
  status!: DeletionRequestStatus;

  @Column({ type: 'timestamptz' })
  scheduledFor!: Date;

  @Column({ type: 'varchar', nullable: true })
  reason!: string | null;

  // When the erasure sweep actually erased the account — distinct from
  // `scheduledFor` (when it *became* due). Stamped by
  // `AccountDeletionProcessorService` alongside `status = Erased`, and left
  // NULL on `Grace`/`Cancelled` rows. NOTE: this row outlives the `users` row
  // it points at — the FK was dropped in
  // `AddDeletionErasureSupport1782800700000` precisely so the erasure ledger
  // survives the erasure.
  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  /**
   * When the "your account is deleted in N days" final warning was sent, or
   * NULL if it has not been.
   *
   * This column exists to make that warning fire ONCE. It is emitted from
   * `AccountDeletionProcessorService`, which is a DAILY cron: without a marker,
   * every member inside the warning window would be told again every morning
   * for the rest of their grace period, which is the opposite of a kindness.
   *
   * Claimed with a conditional UPDATE (`finalWarningSentAt IS NULL` in the
   * WHERE), the same way `eraseDueAccounts` claims a row by its status, so two
   * replicas ticking at the same instant cannot both send. Stamped BEFORE the
   * notification is created: a warning that was claimed and then failed to
   * deliver is a missing notification, while the other ordering is a member
   * warned twice, and only one of those is recoverable by the member reading
   * the delete-account page they are being pointed at anyway.
   *
   * Added by `AddIntakeAndDsarNotificationTypes1794660000000`. NULL on every
   * pre-existing row, deliberately un-backfilled: a member already inside the
   * window when the column landed is owed the warning they never got.
   */
  @Column({ type: 'timestamptz', nullable: true })
  finalWarningSentAt!: Date | null;

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
  previousStatus!: UserStatus | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
