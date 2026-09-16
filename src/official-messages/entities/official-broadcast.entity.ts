import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type OfficialBroadcastStatus =
  'pending' | 'sending' | 'completed' | 'failed';

/**
 * PRD-372: one "message every member" run. Schema and indexes live in
 * `AddOfficialConversationsAndBroadcasts1820540000000`.
 *
 * Delivery is resumable: `cursor_user_id` is the last `users.id` whose batch
 * finished (keyset pagination), `lease_expires_at` + `lease_owner` are the
 * claim a running worker holds, and `attempt_count` counts claims that made no
 * progress, so a run that keeps crashing ends as `failed` instead of looping
 * forever.
 */
@Entity('official_broadcasts')
@Unique('UQ_official_broadcasts_idempotency_key', ['idempotencyKey'])
export class OfficialBroadcast {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  body!: string;

  /** The admin who sent it. NULL once that account is erased (SET NULL). */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: OfficialBroadcastStatus;

  /** Active, non-system members at the moment the broadcast was accepted. */
  @Column({ type: 'integer', default: 0 })
  recipientCount!: number;

  @Column({ type: 'integer', default: 0 })
  deliveredCount!: number;

  @Column({ type: 'varchar', length: 128 })
  idempotencyKey!: string;

  @Column({ type: 'uuid', nullable: true })
  cursorUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  /**
   * The token identifying WHICH worker holds the lease, minted fresh on every
   * claim. `leaseExpiresAt` alone says only "someone holds this until then",
   * which is not an ownership proof: once a batch outlived the lease the sweep
   * on any instance could reclaim the run while the first worker was still
   * writing to it. Every renewal and the completion carry this token, so a
   * worker whose lease was taken matches no row and stops. NULL once the run
   * finishes or hands the lease back.
   */
  @Column({ type: 'uuid', nullable: true })
  leaseOwner!: string | null;

  @Column({ type: 'integer', default: 0 })
  attemptCount!: number;

  @Index('IDX_official_broadcasts_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
