import type { MemberRef } from '../common/member-ref';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from './entities/community-space-request.entity';

export interface SpaceRequestDTO {
  id: string;
  status: CommunitySpaceRequestStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  declineReason: string | null;
  requestedBy: MemberRef | null;
}

export interface LatestSpaceRequestResponseDTO {
  request: SpaceRequestDTO | null;
}

export function toSpaceRequestDTO(
  request: CommunitySpaceRequest,
  requestedBy: MemberRef | null,
): SpaceRequestDTO {
  return {
    id: request.id,
    status: request.status,
    note: request.note,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    declineReason: request.declineReason,
    requestedBy,
  };
}
