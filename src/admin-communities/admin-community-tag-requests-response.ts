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
 */
export interface AdminCommunityTagRequestDTO {
  id: string;
  community: AdminCommunityTagRequestCommunityDTO | null;
  requestedBy: AdminCommunityTagRequesterDTO | null;
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

export function toAdminCommunityTagRequestDTO(
  request: CommunityTagRequest,
  community: AdminCommunityTagRequestCommunityDTO | null,
  requester: MemberRef | null,
): AdminCommunityTagRequestDTO {
  return {
    id: request.id,
    community,
    requestedBy: toAdminCommunityTagRequester(requester),
    label: request.label,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt ? request.resolvedAt.toISOString() : null,
  };
}
