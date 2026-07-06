import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum JobFormat {
  Remote = 'remote',
  InPerson = 'in_person',
  Hybrid = 'hybrid',
  Either = 'either',
}

export enum JobStatus {
  Open = 'open',
  Closed = 'closed',
}

export interface JobDetailBody {
  about: string[];
  dayToDay: string[];
  lookingFor: string[];
  offer: string[];
  reviewerNote: string | null;
}

/**
 * Postgres `numeric` columns round-trip as strings through `pg` by default
 * (arbitrary precision, so the driver never silently narrows them) — this
 * transformer keeps `rateMin`/`rateMax` as `number | null` on the entity so
 * `job-response.ts`'s `JobPay.rateMin/rateMax: number | null` never has to
 * coerce a string itself.
 */
const numericTransformer = {
  to: (value: number | null | undefined): number | null => value ?? null,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_jobs_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Index('IDX_jobs_company_id')
  @Column({ type: 'uuid' })
  companyId: string;

  @Column({ type: 'varchar' })
  title: string;

  // Validated to a known set in `CreateJobDto`, but stored as `varchar` (not
  // a DB enum) — the spec's category set is open-ended, unlike `format`.
  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'varchar' })
  commitment: string;

  @Column({ type: 'varchar' })
  seniority: string;

  @Column({ type: 'enum', enum: JobFormat, enumName: 'job_format_enum' })
  format: JobFormat;

  @Column({ type: 'varchar' })
  location: string;

  @Column({ type: 'varchar', nullable: true })
  city: string | null;

  @Column({ type: 'varchar', nullable: true })
  timezone: string | null;

  // Display-only pay string (e.g. "€40k-50k"); `rateMin`/`rateMax`/`currency`/
  // `ratePer` below are the structured counterparts.
  @Column({ type: 'varchar', nullable: true })
  salary: string | null;

  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  rateMin: number | null;

  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  rateMax: number | null;

  @Column({ type: 'varchar', nullable: true })
  currency: string | null;

  @Column({ type: 'varchar', nullable: true })
  ratePer: string | null;

  @Column({ type: 'boolean', default: false })
  hidePay: boolean;

  @Column({ type: 'boolean', default: false })
  barter: boolean;

  @Column({ type: 'varchar', nullable: true })
  deadline: string | null;

  @Column({ type: 'varchar', nullable: true })
  startDate: string | null;

  // Card blurb; maps to `CreateJobDto.description` at the request boundary.
  @Column({ type: 'text' })
  desc: string;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'boolean', default: false })
  queerRun: boolean;

  @Column({ type: 'varchar', nullable: true })
  qrLabel: string | null;

  // Always populated by the service (never relies on a DB default) — see
  // `JobsService`'s `normalizeDetail`.
  @Column({ type: 'jsonb' })
  detail: JobDetailBody;

  @Column({ type: 'text', array: true, default: '{}' })
  benefits: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  inclusivity: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  screening: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  contacts: string[];

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true })
  link: string | null;

  @Index('IDX_jobs_poster_id')
  @Column({ type: 'uuid' })
  posterId: string;

  @Column({
    type: 'enum',
    enum: JobStatus,
    enumName: 'job_status_enum',
    default: JobStatus.Open,
  })
  status: JobStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
