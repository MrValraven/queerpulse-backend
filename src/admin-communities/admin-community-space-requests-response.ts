import type { MemberRef } from '../common/member-ref';
import type {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from '../communities/entities/community-space-request.entity';

export interface AdminCommunitySpaceRequestCommunityDTO {
  slug: string;
  name: string;
  accessTier: AccessTier;
  avatarUrl: string | null;
}

export interface AdminCommunitySpaceRequesterDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export interface AdminCommunitySpaceRequestDTO {
  id: string;
  community: AdminCommunitySpaceRequestCommunityDTO | null;
  // Omitted (absent) for a reader outside the platform staff tier, matching
  // `AdminCommunityTagRequestDTO`.
  requestedBy?: AdminCommunitySpaceRequesterDTO | null;
  note: string | null;
  status: CommunitySpaceRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  declineReason: string | null;
}

export interface AdminCommunitySpaceRequestsPageDTO {
  items: AdminCommunitySpaceRequestDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminCommunitySpaceRequestDTO(
  request: CommunitySpaceRequest,
  community: Community | null,
  requester: MemberRef | null,
  isPlatformStaffReader: boolean,
): AdminCommunitySpaceRequestDTO {
  return {
    id: request.id,
    community: community
      ? {
          slug: community.slug,
          name: community.name,
          accessTier: community.accessTier,
          avatarUrl: community.avatarImageUrl,
        }
      : null,
    ...(isPlatformStaffReader
      ? {
          requestedBy: requester
            ? {
                slug: requester.slug,
                name: `${requester.firstName} ${requester.lastName}`.trim(),
                avatarUrl: requester.avatarUrl,
              }
            : null,
        }
      : {}),
    note: request.note,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    declineReason: request.declineReason,
  };
}
