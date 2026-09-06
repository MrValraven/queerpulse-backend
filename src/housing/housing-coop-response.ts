import {
  CoopCtaKind,
  CoopFace,
  HousingCoop,
  HousingPhase,
} from './entities/housing-coop.entity';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from './entities/coop-join-request.entity';
import { Paginated } from '../common/pagination';

// Mirrors the frontend `HousingCoopDTO` (economy/api/housingCoop.api.ts) field
// for field. Deliberately drops the entity's `createdAt`/`updatedAt` and the
// `joinRequests` relation — the client never reads them, so they must not ride
// along on the wire.
export interface HousingCoopDTO {
  id: string;
  slug: string;
  name: string;
  nameEm: string | null;
  city: string;
  area: string;
  householdCount: number;
  phase: HousingPhase;
  progress: number;
  operational: boolean;
  operationalSince: string | null;
  formingSince: string | null;
  description: string;
  shareAmountEuros: number | null;
  monthlyEuros: number | null;
  sharesAreTarget: boolean;
  ctaKind: CoopCtaKind;
  faces: CoopFace[];
  published: boolean;
  operatorVerified: boolean;
}

export function toHousingCoopDTO(coop: HousingCoop): HousingCoopDTO {
  return {
    id: coop.id,
    slug: coop.slug,
    name: coop.name,
    nameEm: coop.nameEm,
    city: coop.city,
    area: coop.area,
    householdCount: coop.householdCount,
    phase: coop.phase,
    progress: coop.progress,
    operational: coop.operational,
    operationalSince: coop.operationalSince,
    formingSince: coop.formingSince,
    description: coop.description,
    shareAmountEuros: coop.shareAmountEuros,
    monthlyEuros: coop.monthlyEuros,
    sharesAreTarget: coop.sharesAreTarget,
    ctaKind: coop.ctaKind,
    faces: coop.faces,
    published: coop.published,
    operatorVerified: coop.operatorVerified,
  };
}

// A lean co-op reference embedded in an admin join-request row.
export interface CoopReferenceDTO {
  slug: string;
  name: string;
}

// Mirrors the frontend `AdminJoinRequestDTO` (admin/api/useAdminHousingMutations
// → adminHousing.api). Exposes the applicant details a moderator triages plus a
// lean coop reference — never the raw `coopId`/`userId` FK columns or the full
// embedded `HousingCoop` entity the query eager-joins.
export interface AdminJoinRequestDTO {
  id: string;
  name: string;
  householdSize: string;
  note: string | null;
  status: JoinRequestStatus;
  createdAt: Date;
  coop: CoopReferenceDTO | null;
}

export function toAdminJoinRequestDTO(
  request: CoopJoinRequest,
): AdminJoinRequestDTO {
  return {
    id: request.id,
    name: request.name,
    householdSize: request.householdSize,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt,
    coop: request.coop
      ? { slug: request.coop.slug, name: request.coop.name }
      : null,
  };
}

/**
 * The APPLICANT's own view of a co-op join request (PRD-242).
 *
 * Deliberately a different shape from `AdminJoinRequestDTO` beside it rather
 * than a reuse: that one is the reviewer's row and carries the triage material
 * (`householdSize`, the free-text `note`) that belongs to the console. What the
 * applicant needs is which co-op they asked to join and where their request
 * stands, so that is all this carries. The raw `coopId`/`userId` FK columns and
 * the embedded `HousingCoop` entity never ride along.
 */
export interface MyCoopJoinRequestDTO {
  id: string;
  status: JoinRequestStatus;
  createdAt: Date;
  coop: CoopReferenceDTO | null;
}

export function toMyCoopJoinRequestDTO(
  request: CoopJoinRequest,
): MyCoopJoinRequestDTO {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
    coop: request.coop
      ? { slug: request.coop.slug, name: request.coop.name }
      : null,
  };
}

/**
 * One page of the co-op join-request triage queue (ENG-41). The same envelope as
 * the shared `Paginated<T>` and as the sibling `AdminGroupJoinRequestsPageDTO`:
 * `total` is the size of the whole filtered queue, not of this page, so the
 * console can say how many people are actually waiting instead of implying that
 * whatever arrived is all there is.
 *
 * Declared as an alias of `Paginated<AdminJoinRequestDTO>` rather than a
 * re-spelled interface so the shape can never drift from the envelope every
 * other paginated list on the platform answers with.
 */
export type AdminJoinRequestsPageDTO = Paginated<AdminJoinRequestDTO>;
