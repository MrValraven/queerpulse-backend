import { MemberRef } from '../common/member-ref';
import {
  HousingGroup,
  GroupScreeningQuestion,
} from './entities/housing-group.entity';
import {
  GroupJoinRequest,
  GroupJoinRequestStatus,
  GroupScreeningAnswer,
} from './entities/group-join-request.entity';
import {
  GroupListing,
  GroupListingStatus,
} from './entities/group-listing.entity';

// Mirrors the frontend `HousingGroupDTO`. Deliberately drops the entity's
// timestamps and the `joinRequests`/`listings` relations — the public client
// never reads them, so they must not ride along on the wire.
export interface HousingGroupDTO {
  id: string;
  slug: string;
  name: string;
  nameEm: string | null;
  city: string;
  blurb: string;
  isAccessGated: boolean;
  norms: string[];
  screeningQuestions: GroupScreeningQuestion[];
  memberCount: number;
  published: boolean;
}

export function toHousingGroupDTO(group: HousingGroup): HousingGroupDTO {
  return {
    id: group.id,
    slug: group.slug,
    name: group.name,
    nameEm: group.nameEm,
    city: group.city,
    blurb: group.blurb,
    isAccessGated: group.isAccessGated,
    norms: group.norms,
    screeningQuestions: group.screeningQuestions,
    memberCount: group.memberCount,
    published: group.published,
  };
}

// The public-safe shape of a visible group listing — the norm-required price +
// accessibility fields the group page surfaces. Non-`live` and hidden listings
// are filtered out before mapping (`listVisibleListings`), and the moderation
// fields (`status`, `hidden`/`hiddenReason`, `riskScore`/`riskReasons`) plus
// the poster's `postedByUserId` never reach the public client.
export interface GroupListingDTO {
  id: string;
  title: string;
  description: string;
  neighbourhood: string;
  priceEuros: number;
  accessibilityInfo: string;
}

export function toGroupListingDTO(listing: GroupListing): GroupListingDTO {
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    neighbourhood: listing.neighbourhood,
    priceEuros: listing.priceEuros,
    accessibilityInfo: listing.accessibilityInfo,
  };
}

// A lean group reference embedded in an admin join-request row.
export interface GroupReferenceDTO {
  slug: string;
  name: string;
}

// Mirrors the frontend admin `GroupJoinRequestDTO`. Exposes the applicant
// details a moderator triages — including a best-effort `mutualConnections`
// trust signal — but never the raw FK columns or the full embedded group.
export interface AdminGroupJoinRequestDTO {
  id: string;
  name: string;
  relationship: string;
  answers: GroupScreeningAnswer[];
  note: string | null;
  status: GroupJoinRequestStatus;
  createdAt: Date;
  group: GroupReferenceDTO | null;
  /**
   * Count of the applicant's accepted connections who are already approved
   * members of this group. `null` when the applicant applied anonymously (no
   * `userId` to derive it from). See `HousingGroupsService.listJoinRequests`.
   */
  mutualConnections: number | null;
}

export function toAdminGroupJoinRequestDTO(
  request: GroupJoinRequest,
  mutualConnections: number | null,
): AdminGroupJoinRequestDTO {
  return {
    id: request.id,
    name: request.name,
    relationship: request.relationship,
    answers: request.answers,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt,
    group: request.group
      ? { slug: request.group.slug, name: request.group.name }
      : null,
    mutualConnections,
  };
}

// An admin-side listing row — includes the moderation fields the public DTO
// hides, so a moderator can review a listing before it is ever public
// (`status`, with `riskScore`/`riskReasons` as the queue's sort + rationale)
// and see or reverse a post-publication hide. None of these ride on the public
// `GroupListingDTO`.
//
// LOC-19 added the last four fields. A review queue that shows only the
// outcome cannot be worked: the moderator picking a row up needs to see who
// posted the room (so a decline reaches a real person), and whether somebody
// has already decided this one, when, and on what grounds. `decidedBy` is the
// raw staff `users.id` on purpose — it is the audit key, and this response is
// already behind the housing-moderation guard.
export interface AdminGroupListingDTO extends GroupListingDTO {
  groupSlug: string | null;
  groupName: string | null;
  status: GroupListingStatus;
  riskScore: number;
  riskReasons: string[];
  hidden: boolean;
  hiddenReason: string | null;
  createdAt: Date;
  /** The member who submitted the listing, `null` for an unattributed row. */
  postedBy: MemberRef | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export function toAdminGroupListingDTO(
  listing: GroupListing,
  postedBy: MemberRef | null = null,
): AdminGroupListingDTO {
  return {
    ...toGroupListingDTO(listing),
    groupSlug: listing.group ? listing.group.slug : null,
    groupName: listing.group ? listing.group.name : null,
    status: listing.status,
    riskScore: listing.riskScore,
    riskReasons: listing.riskReasons,
    hidden: listing.hidden,
    hiddenReason: listing.hiddenReason,
    createdAt: listing.createdAt,
    postedBy,
    decidedAt: listing.decidedAt,
    decidedBy: listing.decidedBy,
    decisionReason: listing.decisionReason,
  };
}

/**
 * One page of the group-listing review queue (LOC-19). The pre-existing
 * `GET /admin/housing-groups/listings` returns a single uncapped slab with no
 * page or total, which is fine for a spot check and unusable as the queue a
 * moderator works through, so the paginated read is its own shape rather than
 * a breaking change to that one.
 */
export interface AdminGroupListingsPageDTO {
  items: AdminGroupListingDTO[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The POSTER's own view of a room they submitted to a group (LOC-19).
 *
 * The public `GroupListingDTO` carries no moderation state at all, which is
 * correct for a group page and useless for the person who submitted the room:
 * they had no way to learn whether their post was still waiting, had gone up,
 * had a question against it, or had been refused. A member who does the work
 * of writing a listing is owed the answer.
 *
 * `decisionReason` is the moderator's own words, forwarded verbatim so a
 * question can be answered and a refusal can be understood. `decidedBy` is
 * deliberately NOT here: it is the staff `users.id`, an audit key for the
 * moderation console, and the poster has no use for a staff identity.
 */
export interface MyGroupListingDTO extends GroupListingDTO {
  groupSlug: string | null;
  groupName: string | null;
  status: GroupListingStatus;
  /** A post-publication takedown, with the norm the moderator recorded. */
  hidden: boolean;
  hiddenReason: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toMyGroupListingDTO(
  listing: GroupListing,
  group: Pick<HousingGroup, 'slug' | 'name'> | null = null,
): MyGroupListingDTO {
  const resolvedGroup = group ?? listing.group ?? null;
  return {
    ...toGroupListingDTO(listing),
    groupSlug: resolvedGroup ? resolvedGroup.slug : null,
    groupName: resolvedGroup ? resolvedGroup.name : null,
    status: listing.status,
    hidden: listing.hidden,
    hiddenReason: listing.hiddenReason,
    decidedAt: listing.decidedAt,
    decisionReason: listing.decisionReason,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}
