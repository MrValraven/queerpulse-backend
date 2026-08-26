import { CommunityTagRequest } from '../communities/entities/community-tag-request.entity';
import { MemberRef } from '../common/member-ref';

/** Compact requester identity for the admin review queue — mirrors
 *  `AdminPersonDTO` in `resource-suggestion-response.ts`. */
export interface AdminCommunityTagRequesterDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export function toAdminCommunityTagRequester(
  ref: MemberRef | null,
): AdminCommunityTagRequesterDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/** The community a tag request was submitted for — just enough for the admin
 *  inbox row to name and link to it. */
export interface AdminCommunityTagRequestCommunityDTO {
  slug: string;
  name: string;
}

/**
 * One row on the admin "suggest a tag" review queue
 * (`GET /admin/community-tag-requests`). `resolvedByUserId` is deliberately
 * NOT exposed — mirrors `AdminResourceSuggestionDTO`'s omission of
 * `decidedBy`.
 *
 * `requestedBy` NAMES THE MEMBER who sent the request, and is present only for
 * a caller whose account tier is platform Moderator or Admin. Since OPS-03
 * this queue also opens on the additive `communities` grant, and deciding a
 * tag request is a decision about a WORD: the grant holder still reads the
 * community it came from, the `label` asked for, the requester's `note` and
 * the status, which is the whole of the job the registry delegates. Who typed
 * it adds nothing to that decision, and closing the loop needs no name either
 * (resolving notifies the requester by user id, inside the service). The field
 * is OMITTED rather than nulled so "withheld from you" stays distinguishable
 * from "that member has erased their account", matching how
 * `AdminCommunityQueueItemDTO` withholds a reporter's `detail`.
 */
export interface AdminCommunityTagRequestDTO {
  id: string;
  community: AdminCommunityTagRequestCommunityDTO | null;
  requestedBy?: AdminCommunityTagRequesterDTO | null;
  label: string;
  note: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AdminCommunityTagRequestsPageDTO {
  items: AdminCommunityTagRequestDTO[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * `isPlatformStaffReader` is the caller's ACCOUNT TIER, never their access to
 * the endpoint. The guard has already decided who may call; this only decides
 * whether the requester is named; see `AdminCommunityTagRequestDTO`.
 */
export function toAdminCommunityTagRequestDTO(
  request: CommunityTagRequest,
  community: AdminCommunityTagRequestCommunityDTO | null,
  requester: MemberRef | null,
  isPlatformStaffReader: boolean,
): AdminCommunityTagRequestDTO {
  return {
    id: request.id,
    community,
    ...(isPlatformStaffReader
      ? { requestedBy: toAdminCommunityTagRequester(requester) }
      : {}),
    label: request.label,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt ? request.resolvedAt.toISOString() : null,
  };
}
