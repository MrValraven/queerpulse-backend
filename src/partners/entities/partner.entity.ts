import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PartnerRegion {
  Pt = 'pt',
  Eu = 'eu',
  Int = 'int',
}

export enum PartnerStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
}

export interface PartnerStat {
  value: string;
  label: string;
}

export interface PartnerSection {
  heading: string;
  body: string;
}

export interface PartnerJointWork {
  kicker: string;
  title: string;
  dek: string;
  footLeft: string;
  footRight: string;
}

export interface PartnerTimelineItem {
  date: string;
  title: string;
  body: string;
}

export interface PartnerAtGlance {
  label: string;
  value: string;
}

export interface PartnerContact {
  phone: string | null;
  phoneNote: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
}

@Entity('partners')
export class Partner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_partners_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar' })
  logo: string;

  @Column({
    type: 'enum',
    enum: PartnerRegion,
    enumName: 'partners_region_enum',
  })
  region: PartnerRegion;

  @Column({ type: 'varchar' })
  regionLabel: string;

  @Column({ type: 'varchar' })
  city: string;

  @Column({ type: 'text' })
  desc: string;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'varchar' })
  tier: string;

  @Column({ type: 'varchar' })
  since: string;

  @Column({ type: 'varchar' })
  eyebrow: string;

  @Column({ type: 'varchar' })
  tagline: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  about: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  stats: PartnerStat[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  aboutMore: PartnerSection[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  jointWork: PartnerJointWork[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  timeline: PartnerTimelineItem[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  how: PartnerSection[];

  // No DB default — always populated by the service (`dto.funding ?? ''`),
  // mirroring `contact` below and `VolunteerOpportunity.detail`'s "always
  // fully populated by the service, not the schema" precedent.
  @Column({ type: 'text' })
  funding: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  atGlance: PartnerAtGlance[];

  // Always populated by the service (`PartnersService`'s `normalizeContact`)
  // so every subfield is present (`null`, not omitted) even when a caller
  // supplies only part of `contact` (or omits it entirely).
  @Column({ type: 'jsonb' })
  contact: PartnerContact;

  @Column({
    type: 'enum',
    enum: PartnerStatus,
    enumName: 'partners_status_enum',
    default: PartnerStatus.Pending,
  })
  status: PartnerStatus;

  @Index('IDX_partners_submitted_by_id')
  @Column({ type: 'uuid' })
  submittedById: string;

  @Column({ type: 'text', nullable: true })
  reviewNote: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
