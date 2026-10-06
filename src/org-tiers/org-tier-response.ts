import {
  ChoosableOrgTierCtaType,
  OrgTier,
  OrgTierCtaType,
} from './entities/org-tier.entity';

export interface OrgTierDTO {
  slug: string;
  name: string;
  priceDisplay: string;
  pricePeriod: string;
  dek: string;
  bullets: string[];
  footnote: string;
  ctaType: ChoosableOrgTierCtaType;
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

// A row stored with the retired `toast` type reads back as `propose`, so the
// public card leads to the partner application and the admin editor opens on
// a type it can save.
function choosableCtaType(ctaType: OrgTierCtaType): ChoosableOrgTierCtaType {
  return ctaType === OrgTierCtaType.Link
    ? OrgTierCtaType.Link
    : OrgTierCtaType.Propose;
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
    ctaType: choosableCtaType(tier.ctaType),
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
