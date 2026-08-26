import { MemberRef } from '../common/member-ref';
import {
  ChangemakerNomination,
  ChangemakerNominationStatus,
} from './entities/changemaker-nomination.entity';

/** Display-ready nominator on an admin oversight row. Composed from a
 * `MemberRef` so no raw profile columns leak. */
export interface AdminPersonDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export function toAdminPerson(ref: MemberRef | null): AdminPersonDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/**
 * One changemaker-nomination row on the admin oversight surface — a member
 * putting someone forward for the Change Makers directory. Hand-mapped from the
 * entity; the nominator is resolved to an `AdminPersonDTO` (never a raw profile
 * row), and the free-text nominee name + reason (COM-16) are carried through
 * verbatim.
 *
 * `nominator` is WHO PUT THEM FORWARD, and is present only for a caller whose
 * account tier is platform Moderator or Admin. Since OPS-03 this queue is also
 * reachable with the additive `partnerships` grant. A nomination is a private
 * submission about a THIRD PARTY who never opted in and may not know they were
 * named at all, so the pairing "this named member put that named person
 * forward" is an association about two people, only one of whom is the caller's
 * business. The decision itself is about the nominee's work: a grant holder
 * still reads `nomineeName`, the nominator's `reason` for it, and the whole
 * triage history, which is what maintaining the roster needs. The field is
 * OMITTED rather than nulled so "withheld from you" stays distinguishable from
 * "the nominator erased their account", matching how
 * `AdminCommunityQueueItemDTO` withholds a reporter's `detail`.
 */
export interface AdminChangemakerNominationDTO {
  id: string;
  nominator?: AdminPersonDTO | null;
  nomineeName: string;
  /** The nominator's own words on why — null for nominations submitted
   *  before this field existed (COM-16). */
  reason: string | null;
  /** Triage state (COM-17) — 'pending' until an admin approves or dismisses
   *  it via `PATCH /admin/changemaker-nominations/:id`. */
  status: ChangemakerNominationStatus;
  reviewer: AdminPersonDTO | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface AdminChangemakerNominationsPageDTO {
  items: AdminChangemakerNominationDTO[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `isPlatformStaffReader` is the caller's ACCOUNT TIER, never their access to
 * the endpoint. The guard has already decided who may call; this only decides
 * whether the nominator is named; see `AdminChangemakerNominationDTO`.
 */
export function toAdminChangemakerNominationDTO(
  nomination: ChangemakerNomination,
  nominator: MemberRef | null,
  reviewer: MemberRef | null,
  isPlatformStaffReader: boolean,
): AdminChangemakerNominationDTO {
  return {
    id: nomination.id,
    ...(isPlatformStaffReader ? { nominator: toAdminPerson(nominator) } : {}),
    nomineeName: nomination.nomineeName,
    reason: nomination.reason,
    status: nomination.status,
    reviewer: toAdminPerson(reviewer),
    reviewNote: nomination.reviewNote,
    reviewedAt: nomination.reviewedAt?.toISOString() ?? null,
    createdAt: nomination.createdAt.toISOString(),
  };
}
