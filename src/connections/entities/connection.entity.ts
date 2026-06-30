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

@Entity('connections')
@Unique('UQ_connections_pair', ['userLow', 'userHigh'])
export class Connection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_connections_requester_id')
  @Column({ type: 'uuid' })
  requesterId: string;

  @Index('IDX_connections_addressee_id')
  @Column({ type: 'uuid' })
  addresseeId: string;

  // Canonical unordered pair (least/greatest of requester/addressee) — backs
  // the one-row-per-relationship UNIQUE constraint.
  @Column({ type: 'uuid' })
  userLow: string;

  @Column({ type: 'uuid' })
  userHigh: string;

  @Column({
    type: 'enum',
    enum: ConnectionStatus,
    enumName: 'connections_status_enum',
    default: ConnectionStatus.Pending,
  })
  status: ConnectionStatus;

  @Column({ type: 'uuid', nullable: true })
  blockedBy: string | null;

  @Column({ type: 'text', nullable: true })
  requestMessage: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
}
