import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { HousingCoop } from './housing-coop.entity';

export enum JoinRequestStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

@Entity('coop_join_requests')
export class CoopJoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_coop_join_requests_coop_id')
  @Column({ type: 'uuid' })
  coopId: string;

  @ManyToOne(() => HousingCoop, (coop) => coop.joinRequests, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'coop_id' })
  coop: HousingCoop;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar' })
  householdSize: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'coop_join_requests_status_enum',
    default: JoinRequestStatus.Pending,
  })
  status: JoinRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
