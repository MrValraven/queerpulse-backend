import { MemberRef } from '../common/member-ref';
import {
  Partner,
  PartnerAtGlance,
  PartnerContact,
  PartnerJointWork,
  PartnerRegion,
  PartnerSection,
  PartnerStat,
  PartnerStatus,
  PartnerTimelineItem,
} from './entities/partner.entity';

export interface PartnerCardDTO {
  slug: string;
  name: string;
  logo: string;
  region: PartnerRegion;
  regionLabel: string;
  city: string;
  desc: string;
  tags: string[];
  tier: string;
  since: string;
}

export interface PartnerDetailDTO extends PartnerCardDTO {
  eyebrow: string;
  tagline: string;
  about: string[];
  stats: PartnerStat[];
  aboutMore: PartnerSection[];
  jointWork: PartnerJointWork[];
  timeline: PartnerTimelineItem[];
  how: PartnerSection[];
  funding: string;
  atGlance: PartnerAtGlance[];
  contact: PartnerContact;
}

// Admin-only view (includes review metadata). `id` isn't in the spec's
// interface block, but the endpoint table's `PATCH /partner-applications/:id`
// has to address a row by id and `listApplications()`/`triage()` are the only
// callers that ever see this shape — so it's surfaced here the same way
// `JobApplicationDTO` (also id-addressed, unlike the public `JobCardDTO`)
// carries `id` while the public-facing DTOs don't.
export interface PartnerApplicationDTO extends PartnerDetailDTO {
  id: string;
  status: PartnerStatus;
  submittedBy: MemberRef | null;
  reviewNote: string | null;
  createdAt: string;
}

export function toPartnerCard(p: Partner): PartnerCardDTO {
  return {
    slug: p.slug,
    name: p.name,
    logo: p.logo,
    region: p.region,
    regionLabel: p.regionLabel,
    city: p.city,
    desc: p.desc,
    tags: p.tags,
    tier: p.tier,
    since: p.since,
  };
}

export function toPartnerDetail(p: Partner): PartnerDetailDTO {
  return {
    ...toPartnerCard(p),
    eyebrow: p.eyebrow,
    tagline: p.tagline,
    about: p.about,
    stats: p.stats,
    aboutMore: p.aboutMore,
    jointWork: p.jointWork,
    timeline: p.timeline,
    how: p.how,
    funding: p.funding,
    atGlance: p.atGlance,
    contact: p.contact,
  };
}

export function toPartnerApplication(
  p: Partner,
  submittedBy: MemberRef | null,
): PartnerApplicationDTO {
  return {
    ...toPartnerDetail(p),
    id: p.id,
    status: p.status,
    submittedBy,
    reviewNote: p.reviewNote,
    createdAt: p.createdAt.toISOString(),
  };
}
