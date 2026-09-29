import { toVisibleAvatarUrl } from '../common/member-ref';
import type { Profile } from '../users/entities/profile.entity';
import type { AmbassadorFocusArea } from './ambassador-focus-areas';
import type { Ambassador } from './entities/ambassador.entity';

/**
 * `GET /platform/ambassadors` row. Only active, visible, active-account
 * ambassadors ever appear here.
 */
export interface PlatformAmbassadorRowDTO {
  slug: string;
  focusArea: AmbassadorFocusArea;
  since: string; // ISO timestamp of granted_at
}

/** The staff member who granted or revoked a grant, as the admin page shows them. */
export interface AmbassadorActorDTO {
  slug: string;
  name: string;
}

/**
 * One grant on the admin page (Admin or `partnerships` staff). Carries the
 * internal reasons, so it must only ever leave through the admin routes.
 */
export interface AdminAmbassadorDTO {
  id: string;
  member: {
    slug: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
  focusArea: AmbassadorFocusArea;
  grantedAt: string;
  grantedBy: AmbassadorActorDTO | null;
  grantReason: string;
  revokedAt: string | null;
  revokedBy: AmbassadorActorDTO | null;
  revokeReason: string | null;
  isTagVisible: boolean;
  // The member's staff-set `inviteMonthlyQuota`. When set it replaces every
  // bonus, the ambassador one included, so the page flags it.
  inviteQuotaOverride: number | null;
}

/** `GET /admin/ambassadors/circle`. */
export interface AmbassadorCircleSummaryDTO {
  slug: string;
  memberCount: number;
  isViewerMember: boolean;
}

/** `POST /admin/ambassadors/circle/staff-seat`. */
export interface AmbassadorStaffSeatDTO {
  slug: string;
}

type ActorProfile = Pick<Profile, 'slug' | 'firstName' | 'lastName'>;

export interface AdminAmbassadorSource {
  ambassador: Ambassador;
  memberProfile: Profile;
  inviteQuotaOverride: number | null;
  grantedByProfile: ActorProfile | null;
  revokedByProfile: ActorProfile | null;
}

function toActor(profile: ActorProfile | null): AmbassadorActorDTO | null {
  if (!profile) return null;
  return {
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`.trim(),
  };
}

export function toAdminAmbassador(
  source: AdminAmbassadorSource,
): AdminAmbassadorDTO {
  const { ambassador, memberProfile } = source;
  return {
    id: ambassador.id,
    member: {
      slug: memberProfile.slug,
      firstName: memberProfile.firstName,
      lastName: memberProfile.lastName,
      avatarUrl: toVisibleAvatarUrl(memberProfile),
    },
    focusArea: ambassador.focusArea,
    grantedAt: new Date(ambassador.grantedAt).toISOString(),
    grantedBy: toActor(source.grantedByProfile),
    grantReason: ambassador.grantReason,
    revokedAt: ambassador.revokedAt
      ? new Date(ambassador.revokedAt).toISOString()
      : null,
    revokedBy: toActor(source.revokedByProfile),
    revokeReason: ambassador.revokeReason,
    isTagVisible: memberProfile.isAmbassadorTagVisible,
    inviteQuotaOverride: source.inviteQuotaOverride,
  };
}
