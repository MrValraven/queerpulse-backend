import { toVisibleAvatarUrl } from '../common/member-ref';
import type { Profile } from '../users/entities/profile.entity';
import type { FeatureEarlyAccessGrant } from './entities/feature-early-access-grant.entity';

/**
 * Admin early-access shapes on the wire (plan section 1, contract
 * `EarlyAccess*DTO`). Every mapper below names each field it copies, so a new
 * entity column never reaches the admin pages by accident: no emails, no
 * roles, no grant row ids.
 */

/** The staff member who granted, or null once that account is erased. */
export interface EarlyAccessGrantedByResponse {
  id: string;
  displayName: string;
}

export interface EarlyAccessGrantResponse {
  featureKey: string;
  userId: string;
  grantedAt: string;
  grantedBy: EarlyAccessGrantedByResponse | null;
}

/** `GET /admin/members/:id/early-access`: one entry per feature in early access, registry order. */
export interface MemberEarlyAccessResponse {
  features: { featureKey: string; grant: EarlyAccessGrantResponse | null }[];
}

/** `GET /admin/early-access`: every feature in early access with its grant count. */
export interface EarlyAccessFeaturesResponse {
  features: { featureKey: string; grantCount: number }[];
}

export interface EarlyAccessRosterRowResponse {
  member: {
    userId: string;
    slug: string | null;
    displayName: string;
    /** Honours the member's "Show your photo" toggle (`toVisibleAvatarUrl`). */
    avatarUrl: string | null;
  };
  grantedAt: string;
  grantedBy: EarlyAccessGrantedByResponse | null;
}

/** `GET /admin/early-access/:feature`: newest grants first, at most `limit` rows. */
export interface EarlyAccessRosterResponse {
  featureKey: string;
  total: number;
  limit: number;
  items: EarlyAccessRosterRowResponse[];
}

/** The profile columns a roster row reads. */
export type EarlyAccessRosterProfile = Pick<
  Profile,
  'userId' | 'slug' | 'firstName' | 'lastName' | 'avatarUrl' | 'photoVisible'
>;

/**
 * The label `ModAuditService.nameForUserId` gives a member with no profile
 * row. A roster member without one reads the same way.
 */
const MEMBER_WITHOUT_PROFILE_NAME = 'Member';

/**
 * `grantedByDisplayName` is resolved by the caller (`ModAuditService`), and
 * ignored when the grant's `grantedById` was set null by an erasure.
 */
export function toEarlyAccessGrantedBy(
  grantedById: string | null,
  grantedByDisplayName: string,
): EarlyAccessGrantedByResponse | null {
  if (!grantedById) return null;
  return { id: grantedById, displayName: grantedByDisplayName };
}

export function toEarlyAccessGrantResponse(
  grant: FeatureEarlyAccessGrant,
  grantedByDisplayName: string,
): EarlyAccessGrantResponse {
  return {
    featureKey: grant.featureKey,
    userId: grant.userId,
    grantedAt: grant.createdAt.toISOString(),
    grantedBy: toEarlyAccessGrantedBy(grant.grantedById, grantedByDisplayName),
  };
}

export function toEarlyAccessRosterRow(
  grant: FeatureEarlyAccessGrant,
  memberProfile: EarlyAccessRosterProfile | null,
  grantedByDisplayName: string,
): EarlyAccessRosterRowResponse {
  return {
    member: {
      userId: grant.userId,
      slug: memberProfile?.slug ?? null,
      displayName: memberProfile
        ? `${memberProfile.firstName} ${memberProfile.lastName}`.trim()
        : MEMBER_WITHOUT_PROFILE_NAME,
      avatarUrl: toVisibleAvatarUrl(memberProfile),
    },
    grantedAt: grant.createdAt.toISOString(),
    grantedBy: toEarlyAccessGrantedBy(grant.grantedById, grantedByDisplayName),
  };
}
