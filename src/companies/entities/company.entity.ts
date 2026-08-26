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
  id!: string;

  @Index('UQ_companies_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  nameText!: string;

  @Column({ type: 'varchar' })
  tagline!: string;

  @Column({ type: 'text' })
  about!: string;

  @Column({ type: 'boolean', default: false })
  queerRun!: boolean;

  @Column({ type: 'boolean', default: false })
  queerLed!: boolean;

  @Column({ type: 'boolean', default: false })
  verified!: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  values!: CompanyValue[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  info!: CompanyInfoItem[];

  @Column({ type: 'int', default: 0 })
  teamCount!: number;

  @Column({ type: 'jsonb', nullable: true })
  hiringContact!: CompanyHiringContact | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  work!: CompanyWorkItem[];

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted the company profile, its team roster, its jobs and its reviews. It is now `ON DELETE SET NULL`, so
  // NULL here means "the company profile is unclaimed" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_companies_owner_id')
  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
