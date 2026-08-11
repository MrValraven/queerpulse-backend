import { Changemaker } from '../changemakers/entities/changemaker.entity';
import { Community } from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  LandingFeature,
  LandingSection,
} from './entities/landing-feature.entity';

// ---- Public shapes (eligibility already applied by the caller) ------------

export interface LandingMemberFeatureDTO {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  avatarUrl: string | null;
  quote: string;
  /** The member's own public profile tags — the same set shown on their card
   *  and in directory search, surfaced here so the homepage spotlight can
   *  mirror the richer profile-preview layout without any extra curation. */
  tags: string[];
}

export interface LandingCommunityFeatureDTO {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  blurb: string | null;
}

export interface LandingChangemakerFeatureDTO {
  id: string;
  slug: string;
  name: string;
  cause: string;
  blurb: string;
  tags: string[];
}

export interface LandingFeaturesResponseDTO {
  members: LandingMemberFeatureDTO[];
  communities: LandingCommunityFeatureDTO[];
  changemakers: LandingChangemakerFeatureDTO[];
}

// ---- Admin shapes (include inactive rows + eligibility state) -------------

/** Why a feature is currently withheld from the public response, computed at
 *  read time against the canonical eligibility rules — never stored. */
export type LandingHiddenReason =
  | 'consent_revoked'
  | 'went_private'
  | 'unpublished'
  | 'not_public'
  | 'deleted'
  | null;

export interface AdminTargetSummary {
  slug: string;
  name: string;
  avatarUrl?: string | null;
}

export interface AdminLandingFeatureDTO {
  id: string;
  section: LandingSection;
  targetId: string;
  position: number;
  active: boolean;
  copy: LandingFeature['copy'];
  target: AdminTargetSummary | null;
  eligible: boolean;
  hiddenReason: LandingHiddenReason;
}

export interface AdminEligibleEntityDTO {
  targetId: string;
  slug: string;
  name: string;
  avatarUrl?: string | null;
}

// ---- Mappers ----------------------------------------------------------------

/** `feature.id` (not the target's id) is the public list-key here — the same
 *  convention `AdminLandingFeatureDTO` uses to keep `id` (the row) distinct
 *  from `targetId`. `slug` is what routes a card to the featured entity's own
 *  page. */
export function toLandingMemberFeatureDTO(
  feature: LandingFeature,
  profile: Profile,
): LandingMemberFeatureDTO {
  const copy = feature.copy as { quote: string };
  return {
    id: feature.id,
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`,
    tagline: profile.tagline,
    avatarUrl: profile.avatarUrl,
    quote: copy.quote,
    tags: profile.tags,
  };
}

export function toLandingCommunityFeatureDTO(
  feature: LandingFeature,
  community: Community,
  memberCount: number,
): LandingCommunityFeatureDTO {
  const copy = feature.copy as { blurb?: string };
  return {
    id: feature.id,
    slug: community.slug,
    name: community.name,
    memberCount,
    blurb: copy.blurb ?? null,
  };
}

export function toLandingChangemakerFeatureDTO(
  feature: LandingFeature,
  changemaker: Changemaker,
): LandingChangemakerFeatureDTO {
  const copy = feature.copy as {
    cause: string;
    blurb: string;
    tags?: string[];
  };
  return {
    id: feature.id,
    slug: changemaker.slug,
    name: changemaker.name,
    cause: copy.cause,
    blurb: copy.blurb,
    tags: copy.tags ?? [],
  };
}

export function toAdminLandingFeatureDTO(
  feature: LandingFeature,
  target: AdminTargetSummary | null,
  eligible: boolean,
  hiddenReason: LandingHiddenReason,
): AdminLandingFeatureDTO {
  return {
    id: feature.id,
    section: feature.section,
    targetId: feature.targetId,
    position: feature.position,
    active: feature.active,
    copy: feature.copy,
    target,
    eligible,
    hiddenReason,
  };
}

export function toAdminEligibleEntityDTO(
  targetId: string,
  slug: string,
  name: string,
  avatarUrl: string | null,
): AdminEligibleEntityDTO {
  return { targetId, slug, name, avatarUrl };
}
