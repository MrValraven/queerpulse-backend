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
  featured: boolean;
  testimonialQuote: string | null;
  testimonialAuthor: string | null;
  testimonialRole: string | null;
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
// interface block, but the endpoint table's triage route (now
// `PATCH /admin/partners/applications/:id`)
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
  /**
   * OPS-04. The staff member currently working this application, or null when
   * nobody has claimed it. Meaningful while `status` is `pending` (that IS the
   * open application); it simply stops mattering once the application has been
   * approved or rejected.
   */
  assignedStaffId: string | null;
  /** Only present when `assignedStaffId` is set. "Deleted member" after that
   *  reviewer's erasure (see `queueAssigneeName`). */
  assignedStaffName?: string;
  /**
   * ISO 8601. When this application should have been answered by, stamped at
   * submission from `PARTNER_APPLICATION_REVIEW_WINDOW_MS`. NULL means NO
   * CLOCK, never overdue: applications settled before OPS-04 existed carry
   * none. This column is the whole point of OPS-04 for this queue, which had
   * nothing to stop an application sitting for six weeks.
   */
  dueAt: string | null;
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
    featured: p.featured,
    testimonialQuote: p.testimonialQuote,
    testimonialAuthor: p.testimonialAuthor,
    testimonialRole: p.testimonialRole,
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
  // OPS-04. Resolved by the caller through `optionalQueueAssigneeName` against
  // the same batched profile lookup the submitter already uses.
  assignedStaffName?: string,
): PartnerApplicationDTO {
  return {
    ...toPartnerDetail(p),
    id: p.id,
    status: p.status,
    submittedBy,
    reviewNote: p.reviewNote,
    createdAt: p.createdAt.toISOString(),
    assignedStaffId: p.assignedStaffId,
    ...(assignedStaffName ? { assignedStaffName } : {}),
    dueAt: p.dueAt ? p.dueAt.toISOString() : null,
  };
}
