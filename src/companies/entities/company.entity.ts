import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface CompanyValue {
  title: string;
  desc: string;
}

export interface CompanyInfoItem {
  label: string;
  value: string;
}

export interface CompanyWorkItem {
  label: string;
  imageUrl: string | null;
}

export interface CompanyHiringContact {
  name: string;
  role: string;
}

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_companies_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  nameText: string;

  @Column({ type: 'varchar' })
  tagline: string;

  @Column({ type: 'text' })
  about: string;

  @Column({ type: 'boolean', default: false })
  queerRun: boolean;

  @Column({ type: 'boolean', default: false })
  queerLed: boolean;

  @Column({ type: 'boolean', default: false })
  verified: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  values: CompanyValue[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  info: CompanyInfoItem[];

  @Column({ type: 'int', default: 0 })
  teamCount: number;

  @Column({ type: 'jsonb', nullable: true })
  hiringContact: CompanyHiringContact | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  work: CompanyWorkItem[];

  @Index('IDX_companies_owner_id')
  @Column({ type: 'uuid' })
  ownerId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
