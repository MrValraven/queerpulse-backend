import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// The CTA behaviour a tier card renders: a toast (info acknowledgement), an
// internal link (to `ctaTarget`), or the "propose a partnership" anchor to the
// contact form. Kept as an enum so the FE can switch on a stable value rather
// than parse copy.
export enum OrgTierCtaType {
  Toast = 'toast',
  Link = 'link',
  Propose = 'propose',
}

@Entity('org_tiers')
export class OrgTier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_org_tiers_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  name: string;

  // Display string, not a number — "€2.4k", "Custom", "€15k+".
  @Column({ type: 'varchar' })
  priceDisplay: string;

  @Column({ type: 'varchar' })
  pricePeriod: string;

  @Column({ type: 'text' })
  dek: string;

  @Column({ type: 'text', array: true, default: '{}' })
  bullets: string[];

  @Column({ type: 'text' })
  footnote: string;

  @Column({
    type: 'enum',
    enum: OrgTierCtaType,
    enumName: 'org_tiers_cta_type_enum',
  })
  ctaType: OrgTierCtaType;

  @Column({ type: 'varchar' })
  ctaLabel: string;

  // Route/anchor for `ctaType = link`; null otherwise.
  @Column({ type: 'varchar', nullable: true })
  ctaTarget: string | null;

  // The highlighted middle tier (one expected, not enforced).
  @Column({ type: 'boolean', default: false })
  featured: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  published: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
