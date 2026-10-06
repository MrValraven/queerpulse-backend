import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// The CTA behaviour a tier card renders: an internal link (to `ctaTarget`), or
// the "propose a partnership" anchor to the partner application. Kept as an
// enum so the FE can switch on a stable value and leave the copy alone.
//
// `Toast` is retired. Its button only showed a toast repeating its own label,
// so an organisation clicking it reached nobody. The value stays here because
// `org_tiers_cta_type_enum` still holds it in Postgres, but the write DTO only
// accepts `CHOOSABLE_ORG_TIER_CTA_TYPES` and `toOrgTier` reads a stored toast
// row back as `propose`.
export enum OrgTierCtaType {
  Toast = 'toast',
  Link = 'link',
  Propose = 'propose',
}

/** The CTA types an admin can choose for a tier. */
export const CHOOSABLE_ORG_TIER_CTA_TYPES = [
  OrgTierCtaType.Link,
  OrgTierCtaType.Propose,
] as const;

export type ChoosableOrgTierCtaType =
  (typeof CHOOSABLE_ORG_TIER_CTA_TYPES)[number];

@Entity('org_tiers')
export class OrgTier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_org_tiers_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  name!: string;

  // Display string, not a number — "€2.4k", "Custom", "€15k+".
  @Column({ type: 'varchar' })
  priceDisplay!: string;

  @Column({ type: 'varchar' })
  pricePeriod!: string;

  @Column({ type: 'text' })
  dek!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  bullets!: string[];

  @Column({ type: 'text' })
  footnote!: string;

  @Column({
    type: 'enum',
    enum: OrgTierCtaType,
    enumName: 'org_tiers_cta_type_enum',
  })
  ctaType!: OrgTierCtaType;

  @Column({ type: 'varchar' })
  ctaLabel!: string;

  // Route/anchor for `ctaType = link`; null otherwise.
  @Column({ type: 'varchar', nullable: true })
  ctaTarget!: string | null;

  // The highlighted middle tier (one expected, not enforced).
  @Column({ type: 'boolean', default: false })
  featured!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ type: 'boolean', default: true })
  published!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
