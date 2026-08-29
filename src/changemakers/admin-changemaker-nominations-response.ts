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
 * `nominator`, `nominee` and `nomineeContact` all ride ONE rule, described
 * below for `nominator` and applied identically to the other two. COM-18 added
 * the last pair: where to find the person who was named. A linked member is a
 * profile, and a contact string is a stranger's handle or address, which is
 * personal data about someone who never opted in and cannot see or delete it
 * here. Both are "how to reach a third party", the same category of fact as
 * "who named them", so they are withheld from the same readers rather than
 * getting a looser rule of their own. What a `partnerships` grant holder reads
 * is unchanged in kind: the nominee's name, the nominator's reason, and the
 * whole triage history, which is what maintaining the roster needs.
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
  /** The nominee themselves, when the nominator picked them out of the member
   *  search (COM-18) — null when they aren't a member here, or when the
   *  account behind the stored id is gone. Withheld like `nominator`. */
  nominee?: AdminPersonDTO | null;
  /** Where else to find the nominee, in the nominator's own words (COM-18) —
   *  a handle, a link, an email. Withheld like `nominator`. */
  nomineeContact?: string | null;
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
  nominee: MemberRef | null,
  reviewer: MemberRef | null,
  isPlatformStaffReader: boolean,
): AdminChangemakerNominationDTO {
  return {
    id: nomination.id,
    ...(isPlatformStaffReader
      ? {
          nominator: toAdminPerson(nominator),
          nominee: toAdminPerson(nominee),
          nomineeContact: nomination.nomineeContact,
        }
      : {}),
    nomineeName: nomination.nomineeName,
    reason: nomination.reason,
    status: nomination.status,
    reviewer: toAdminPerson(reviewer),
    reviewNote: nomination.reviewNote,
    reviewedAt: nomination.reviewedAt?.toISOString() ?? null,
    createdAt: nomination.createdAt.toISOString(),
  };
}
