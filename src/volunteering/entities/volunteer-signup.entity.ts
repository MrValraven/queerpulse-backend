import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('volunteer_signups')
@Unique('UQ_volunteer_signups', ['opportunityId', 'userId'])
export class VolunteerSignup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_volunteer_signups_opportunity_id')
  @Column({ type: 'uuid' })
  opportunityId: string;

  @Index('IDX_volunteer_signups_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
