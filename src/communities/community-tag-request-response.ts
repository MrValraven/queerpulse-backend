import { CommunityTagRequest } from './entities/community-tag-request.entity';

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
