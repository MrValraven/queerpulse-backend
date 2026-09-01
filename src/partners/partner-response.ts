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

/**
 * What the APPLICANT sees about their own application (PRD-37).
 *
 * A separate, deliberately small shape rather than a reuse of
 * `PartnerApplicationDTO`, which is the admin queue's view and carries the
 * reviewer's identity, the internal review note and the ops due clock. There
 * is no global serializer in this app, so anything not named here cannot leak
 * — and that is the point of writing the applicant's view as its own
 * interface instead of spreading the admin one and deleting fields, which
 * would silently re-admit every field a later change adds to the admin DTO.
 *
 * WHAT IS WITHHELD, and why (the same boundary `ReportsController.listMine`
 * draws, which returns `resolvedAt` and none of the moderator's reasoning):
 *
 *  - `assignedStaffId` / `assignedStaffName` — which staff member is holding
 *    the row. That is a reviewer's identity attached to a decision about the
 *    applicant, and no other "mine" endpoint discloses it.
 *  - `dueAt` — the partnerships team's internal fourteen-day SLA. It is an
 *    ops clock the team set for itself, and showing it to an applicant turns
 *    it into a promise nobody made to them.
 *  - `featured`, `testimonialQuote`, `testimonialAuthor`, `testimonialRole` —
 *    editorial fields the platform owns, not the applicant's, and meaningless
 *    before approval.
 *  - `submittedBy` — the caller themselves, by definition. Nothing to say.
 *
 * WHAT IS EXPOSED: the organisation's own submitted identity (`name`, `slug`,
 * `city`, `tagline`), which is their own content read back to them; `status`;
 * `createdAt`; `decidedAt`, the answer to "have I heard back yet?"; and, on a
 * refusal, `reviewNote`. `slug` is here because an APPROVED application is a
 * live directory entry and the submissions index links straight to it; on a
 * pending or rejected row it resolves to no public page, which is correct.
 */
export interface MyPartnerApplicationDTO {
  id: string;
  slug: string;
  name: string;
  city: string;
  tagline: string;
  status: PartnerStatus;
  /** ISO 8601. When the application was submitted. */
  createdAt: string;
  /**
   * ISO 8601, or null. When an admin approved or rejected it. NULL while the
   * application is still pending, and also on applications settled before
   * this was recorded — see `Partner.decidedAt`. A client must render a
   * decided-with-no-date row as decided, never as still waiting.
   */
  decidedAt: string | null;
  /**
   * The reviewer's reason for turning the application down, or null.
   *
   * PRD-48 settled on the record that a partner application's review note is
   * member-facing: `SUBMISSION_KIND_NOTIFICATION[PartnerApplication]` sets
   * `isReviewNoteDelivered: true`, so the decision notification already carries
   * it, on the reasoning that a refusal with the reason withheld is a refusal
   * with no reason. Given that, withholding it HERE would be the worst of the
   * three options: the applicant reads the reason once in the bell and then
   * loses it permanently the moment they clear the row, on the very page built
   * to be the durable record.
   *
   * TWO CONDITIONS, both load-bearing (see `toMyPartnerApplication`):
   *
   *  - only on a `rejected` row, because `reviewNote` is written only by a
   *    reject and is never cleared, so an application refused once and later
   *    approved still carries the old refusal in the column;
   *  - only when `decidedAt` is set, which is exactly the set of decisions made
   *    after the note became member-facing. Every application settled before
   *    that carries `decidedAt: null` (the migration deliberately does not
   *    backfill it), and its note was written by a reviewer with every reason
   *    to believe it was private. Publishing those retroactively is not a
   *    decision this endpoint gets to make on their behalf.
   */
  reviewNote: string | null;
}

export function toMyPartnerApplication(p: Partner): MyPartnerApplicationDTO {
  // See `MyPartnerApplicationDTO.reviewNote` for why both halves are required.
  const isNoteMemberFacing =
    p.status === PartnerStatus.Rejected && p.decidedAt !== null;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    city: p.city,
    tagline: p.tagline,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
    reviewNote: isNoteMemberFacing ? p.reviewNote : null,
  };
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
