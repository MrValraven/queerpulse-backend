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
export interface AdminGroupListingDTO extends GroupListingDTO {
  groupSlug: string | null;
  status: GroupListingStatus;
  riskScore: number;
  riskReasons: string[];
  hidden: boolean;
  hiddenReason: string | null;
  createdAt: Date;
}

export function toAdminGroupListingDTO(
  listing: GroupListing,
): AdminGroupListingDTO {
  return {
    ...toGroupListingDTO(listing),
    groupSlug: listing.group ? listing.group.slug : null,
    status: listing.status,
    riskScore: listing.riskScore,
    riskReasons: listing.riskReasons,
    hidden: listing.hidden,
    hiddenReason: listing.hiddenReason,
    createdAt: listing.createdAt,
  };
}
