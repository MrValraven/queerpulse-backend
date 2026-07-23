import { OrgTier, OrgTierCtaType } from './entities/org-tier.entity';

export interface OrgTierDTO {
  slug: string;
  name: string;
  priceDisplay: string;
  pricePeriod: string;
  dek: string;
  bullets: string[];
  footnote: string;
  ctaType: OrgTierCtaType;
  ctaLabel: string;
  ctaTarget: string | null;
  featured: boolean;
}

// Admin view adds the id + publish/order metadata the public page never reads.
export interface OrgTierAdminDTO extends OrgTierDTO {
  id: string;
  sortOrder: number;
  published: boolean;
}

export function toOrgTier(tier: OrgTier): OrgTierDTO {
  return {
    slug: tier.slug,
    name: tier.name,
    priceDisplay: tier.priceDisplay,
    pricePeriod: tier.pricePeriod,
    dek: tier.dek,
    bullets: tier.bullets,
    footnote: tier.footnote,
    ctaType: tier.ctaType,
    ctaLabel: tier.ctaLabel,
    ctaTarget: tier.ctaTarget,
    featured: tier.featured,
  };
}

export function toOrgTierAdmin(tier: OrgTier): OrgTierAdminDTO {
  return {
    ...toOrgTier(tier),
    id: tier.id,
    sortOrder: tier.sortOrder,
    published: tier.published,
  };
}
