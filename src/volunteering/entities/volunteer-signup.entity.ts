import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum SignupStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

@Entity('volunteer_signups')
@Unique('UQ_volunteer_signups', ['opportunityId', 'userId'])
export class VolunteerSignup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_volunteer_signups_opportunity_id')
  @Column({ type: 'uuid' })
  opportunityId!: string;

  @Index('IDX_volunteer_signups_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'enum', enum: SignupStatus, default: SignupStatus.Pending })
  status!: SignupStatus;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
