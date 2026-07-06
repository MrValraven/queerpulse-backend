import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OpportunityCause {
  Rights = 'rights',
  Health = 'health',
  Youth = 'youth',
  Housing = 'housing',
  Arts = 'arts',
}

export enum OpportunityCommitLevel {
  Low = 'low',
  Medium = 'medium',
}

export enum OpportunityStatus {
  Open = 'open',
  Closed = 'closed',
}

export interface OpportunityTask {
  title: string;
  desc: string;
}

export interface OpportunityCommitment {
  label: string;
  detail: string;
}

export interface OpportunityDetailBody {
  why: string[];
  tasks: OpportunityTask[];
  commitments: OpportunityCommitment[];
  goodFor: string[];
  teamIntro: string | null;
}

@Entity('volunteer_opportunities')
export class VolunteerOpportunity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_volunteer_opportunities_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  org: string;

  // Nullable, no FK constraint yet — the `partners` table doesn't exist
  // until Phase D, which adds the FK constraint in its own migration (see
  // `.superpowers/sdd/spec-phaseC-volunteering.md`). Indexed in anticipation
  // of Phase D's "opportunities for this partner" queries even though
  // nothing in Phase C reads it back out.
  @Index('IDX_volunteer_opportunities_partner_id')
  @Column({ type: 'uuid', nullable: true })
  partnerId: string | null;

  @Column({ type: 'varchar' })
  role: string;

  @Column({
    type: 'enum',
    enum: OpportunityCause,
    enumName: 'volunteer_opportunities_cause_enum',
  })
  cause: OpportunityCause;

  @Column({
    type: 'enum',
    enum: OpportunityCommitLevel,
    enumName: 'volunteer_opportunities_commit_enum',
  })
  commit: OpportunityCommitLevel;

  // Display-only commitment string (e.g. "2 hrs / week"); `commit` above is
  // the coarse low/medium filter facet.
  @Column({ type: 'varchar' })
  time: string;

  @Column({ type: 'varchar' })
  location: string;

  @Column({ type: 'text', array: true, default: '{}' })
  skills: string[];

  // Card blurb; maps to `CreateOpportunityDto.desc` at the request boundary.
  @Column({ type: 'text' })
  desc: string;

  // Always populated by the service (never relies on a DB default) — see
  // `VolunteeringService`'s `normalizeDetail`.
  @Column({ type: 'jsonb' })
  detail: OpportunityDetailBody;

  @Column({ type: 'int' })
  spotsTotal: number;

  @Column({ type: 'varchar' })
  applyRole: string;

  @Index('IDX_volunteer_opportunities_poster_id')
  @Column({ type: 'uuid' })
  posterId: string;

  @Column({
    type: 'enum',
    enum: OpportunityStatus,
    enumName: 'volunteer_opportunities_status_enum',
    default: OpportunityStatus.Open,
  })
  status: OpportunityStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
