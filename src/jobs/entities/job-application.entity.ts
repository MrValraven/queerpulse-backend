import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum JobApplicationStatus {
  Submitted = 'submitted',
  Reviewing = 'reviewing',
  Accepted = 'accepted',
  Declined = 'declined',
}

export interface JobApplicationAnswer {
  question: string;
  answer: string;
}

@Entity('job_applications')
@Unique('UQ_job_applications', ['jobId', 'applicantId'])
export class JobApplication {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_job_applications_job_id')
  @Column({ type: 'uuid' })
  jobId: string;

  @Index('IDX_job_applications_applicant_id')
  @Column({ type: 'uuid' })
  applicantId: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  answers: JobApplicationAnswer[];

  @Column({ type: 'text', nullable: true })
  coverNote: string | null;

  @Column({
    type: 'enum',
    enum: JobApplicationStatus,
    enumName: 'job_applications_status_enum',
    default: JobApplicationStatus.Submitted,
  })
  status: JobApplicationStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
