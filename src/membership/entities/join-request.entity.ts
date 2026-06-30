import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum JoinRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

@Entity('join_requests')
export class JoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'text' })
  message: string;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'join_requests_status_enum',
    default: JoinRequestStatus.Pending,
  })
  status: JoinRequestStatus;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
