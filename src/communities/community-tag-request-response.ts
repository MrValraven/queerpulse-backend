import { MemberRef } from '../common/member-ref';
import {
  CommunityTagRequest,
  CommunityTagRequestStatus,
} from './entities/community-tag-request.entity';

/** Shape returned by `POST /communities/:slug/tag-requests` — just enough
 *  for the requester's own success state to confirm what was sent. */
export interface CommunityTagRequestResponseDTO {
  id: string;
  label: string;
  note: string | null;
  status: string;
  createdAt: string;
}

export function toCommunityTagRequestResponse(
  request: CommunityTagRequest,
): CommunityTagRequestResponseDTO {
  return {
    id: request.id,
    label: request.label,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
  };
}

/**
 * One row of a community's OWN suggestion log
 * (`GET /communities/:slug/tag-requests`, PRD-150), read by that community's
 * owner, co-owners and moderators. The richer sibling of
 * `CommunityTagRequestResponseDTO` above, which is only the echo the POST
 * hands straight back to its sender.
 *
 * `status` is the whole answer this endpoint exists to give, and it means what
 * `CommunityTagRequestStatus` says it means: `resolved` is "an admin has read
 * this", never "the tag now exists". `COMMUNITY_TAGS` stays a hardcoded,
 * code-reviewed array by deliberate product decision, so no reader of this DTO
 * should render a resolved suggestion as an available tag.
 *
 * `resolvedAt` says WHEN, and there is deliberately no resolving admin here:
 * the platform person who read a community's suggestion is nobody that
 * community needs named, and `AdminCommunityTagRequestDTO` withholds the same
 * field from the admin queue itself.
 *
 * ## `requestedBy` names the member, on purpose
 *
 * `AdminCommunityTagRequestDTO` withholds the requester from a `communities`
 * grant holder because deciding about a WORD needs no name. Here the name is
 * part of the job: this reader is the community's own staff, the requester is
 * by construction one of them (`createTagRequest` is owner/mod gated), and the
 * two are already named to each other on the roster this same reader can open.
 * It is what lets an owner tell their own suggestion from a co-moderator's,
 * and go and ask about it instead of filing a second one. Null only when the
 * profile cannot be resolved; an erased account takes its tag requests with it
 * (`ON DELETE CASCADE`), so in practice this is the null-tolerance every
 * `MemberRef` site carries rather than a state anyone will see.
 */
export interface CommunityTagRequestDTO {
  id: string;
  label: string;
  note: string | null;
  status: CommunityTagRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  requestedBy: MemberRef | null;
}

/** `GET /communities/:slug/tag-requests`: the community's whole suggestion
 *  log, newest first, capped at `DEFAULT_LIST_LIMIT` (see
 *  `CommunitiesService.listTagRequests` for why a cap and not a page). */
export interface CommunityTagRequestsResponseDTO {
  items: CommunityTagRequestDTO[];
}

export function toCommunityTagRequest(
  request: CommunityTagRequest,
  requestedBy: MemberRef | null,
): CommunityTagRequestDTO {
  return {
    id: request.id,
    label: request.label,
    note: request.note,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt ? request.resolvedAt.toISOString() : null,
    requestedBy,
  };
}
