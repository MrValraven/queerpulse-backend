import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum ConnectionStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Blocked = 'blocked',
}

/**
 * PRD-363: what an unblock put back. `accepted` and `pending` mean the pair is
 * exactly where it was before the block; `none` means there was nothing to
 * restore (no connection, a `declined` one, or a block placed by the other
 * member that still stands).
 */
export type RestoredConnectionStatus = 'accepted' | 'pending' | 'none';

export function toRestoredConnectionStatus(
  status: ConnectionStatus | null | undefined,
): RestoredConnectionStatus {
  if (status === ConnectionStatus.Accepted) return 'accepted';
  if (status === ConnectionStatus.Pending) return 'pending';
  return 'none';
}

@Entity('connections')
@Unique('UQ_connections_pair', ['userLow', 'userHigh'])
export class Connection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_connections_requester_id')
  @Column({ type: 'uuid' })
  requesterId!: string;

  @Index('IDX_connections_addressee_id')
  @Column({ type: 'uuid' })
  addresseeId!: string;

  // Canonical unordered pair (least/greatest of requester/addressee) — backs
  // the one-row-per-relationship UNIQUE constraint.
  @Column({ type: 'uuid' })
  userLow!: string;

  @Index('IDX_connections_user_high')
  @Column({ type: 'uuid' })
  userHigh!: string;

  @Column({
    type: 'enum',
    enum: ConnectionStatus,
    enumName: 'connections_status_enum',
    default: ConnectionStatus.Pending,
  })
  status!: ConnectionStatus;

  @Index('IDX_connections_blocked_by')
  @Column({ type: 'uuid', nullable: true })
  blockedBy!: string | null;

  /**
   * PRD-363: the status a block overwrote, so the blocker's unblock can put it
   * back exactly. Written only when the pair was `accepted` or `pending` at
   * the moment of the block; NULL for a `declined` pair (nothing worth
   * restoring, unblock keeps returning it to `declined`) and for every block
   * placed before this column existed. Cleared when the unblock restores it.
   * The requester direction needs no copy: nothing can re-point
   * `requesterId` while the row reads `blocked`.
   */
  @Column({
    type: 'enum',
    enum: ConnectionStatus,
    enumName: 'connections_status_enum',
    nullable: true,
  })
  statusBeforeBlock!: ConnectionStatus | null;

  /** PRD-363: the `respondedAt` a block overwrote, restored alongside
   *  {@link statusBeforeBlock} (NULL again for a restored `pending`). */
  @Column({ type: 'timestamptz', nullable: true })
  respondedAtBeforeBlock!: Date | null;

  @Column({ type: 'text', nullable: true })
  requestMessage!: string | null;

  // Why the requester reached out: an "open to" preset (`open:<id>`), a member's
  // own words (`custom:<label>`), or a generic reason id. Surfaced to the
  // addressee alongside the request message.
  @Column({ type: 'text', nullable: true })
  requestReason!: string | null;

  // The mutual connection who introduced the requester to a `network`-visibility
  // target (single-step intro). Null for open/private/already-connected requests.
  @Column({ type: 'uuid', nullable: true })
  introducedBy!: string | null;

  // Set when the target is `private`-visibility: the request is allowed through
  // but recorded for later moderation. Persist-only (not surfaced in responses).
  @Column({ type: 'boolean', default: false })
  flagged!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
