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
