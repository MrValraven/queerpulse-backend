import { Changemaker } from '../changemakers/entities/changemaker.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import { toImageUrl } from '../common/image-url';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { Event } from '../events/entities/event.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
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
  /** The member's own public profile tags: the same set shown on their card
   *  and in directory search, surfaced here so the homepage spotlight can
   *  mirror the richer profile-preview layout without any extra curation. */
  tags: string[];
}

/** A single roster face on a featured-community card: the community's owner
 *  ("kept by") or one of its members. Name (for the avatar's initials fallback)
 *  + a resolved avatar URL, nothing more: the public homepage needs no slug or
 *  contact detail, and omitting them keeps the payload from leaking a member
 *  directory. */
export interface LandingCommunityFaceDTO {
  name: string;
  avatarUrl: string | null;
}

export interface LandingCommunityFeatureDTO {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  blurb: string | null;
  /** Resolved (`toImageUrl`) cover image, or null → the card renders a tinted
   *  placeholder instead (communities without a cover). */
  coverImageUrl: string | null;
  /** The 6-value community `type`, shown as the card's category badge. */
  category: CommunityType;
  /** Access level, shown as an "open / request / private" chip. */
  accessTier: AccessTier;
  /** Year the community was created (`createdAt`), shown as "since ‹year›".
   *  This year comes entirely from the record's own creation timestamp; the
   *  community entity carries no separate, user-entered founding-date field. */
  foundedYear: number;
  /** The community's `features` list → the card's "what you get" chips. */
  features: string[];
  /** The owner, rendered as "kept by ‹name›". Null when the owner profile is
   *  unresolved, or when it fails `isPublicFace` (private, hidden or the
   *  owner's account suspended): the card then omits the "kept by" line
   *  entirely, so a name that should no longer be public never renders. */
  owner: LandingCommunityFaceDTO | null;
  /** A capped set of member avatars for the roster strip. Empty when the
   *  community hides its roster (`rosterVisible === false`): the card then
   *  leans on `memberCount` alone and keeps the roster private. */
  faces: LandingCommunityFaceDTO[];
}

export interface LandingChangemakerFeatureDTO {
  id: string;
  slug: string;
  name: string;
  cause: string;
  blurb: string;
  tags: string[];
}

/** A curated public gathering, carrying only what the homepage row renders.
 *  The place is AREA-LEVEL: the neighbourhood the host picked, or the online
 *  flag. The street `address`, `arrivalNotes`, `venue`, `onlineUrl`, the host
 *  and every attendee stay off this payload, the same split the event
 *  response mapper keeps for a stranger without a 'going' RSVP. */
export interface LandingGatheringFeatureDTO {
  id: string;
  slug: string;
  title: string;
  /** ISO 8601 start instant. */
  startAt: string;
  /** IANA zone the host scheduled it in. */
  timezone: string;
  /** The neighbourhood name, or null when the host gave none. */
  area: string | null;
  isOnline: boolean;
  /** Resolved (`toImageUrl`) cover image, or null. */
  coverImageUrl: string | null;
  /** The admin's optional kicker line, shown above the title. */
  blurb: string | null;
}

/** A curated published magazine story. `authorName` is the byline exactly as
 *  the article prints it (`magazine_author.name`); the payload carries no
 *  member id or profile link. */
export interface LandingStoryFeatureDTO {
  id: string;
  slug: string;
  title: string;
  dek: string;
  /** Resolved (`toImageUrl`) lead art, or null when the desk set none. */
  coverImageUrl: string | null;
  authorName: string;
  readMinutes: number;
  /** The admin's optional kicker line, shown above the title. */
  blurb: string | null;
}

export interface LandingFeaturesResponseDTO {
  members: LandingMemberFeatureDTO[];
  communities: LandingCommunityFeatureDTO[];
  changemakers: LandingChangemakerFeatureDTO[];
  gatherings: LandingGatheringFeatureDTO[];
  stories: LandingStoryFeatureDTO[];
}

// ---- Admin shapes (include inactive rows + eligibility state) -------------

/** Why a feature is currently withheld from the public response, computed at
 *  read time against the canonical eligibility rules. It is never stored. */
export type LandingHiddenReason =
  | 'consent_revoked'
  | 'went_private'
  | 'unpublished'
  | 'not_public'
  | 'deleted'
  | 'cancelled'
  | 'ended'
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

/** `feature.id` (the feature row's own id, distinct from the target's id) is
 *  the public list-key here, the same convention `AdminLandingFeatureDTO`
 *  uses to keep `id` (the row) distinct from `targetId`. `slug` is what
 *  routes a card to the featured entity's own page. */
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
    // Resolve the stored avatar (a private storage key for uploaded photos, an
    // absolute URL for Google avatars) into a fetchable `/files/*` URL, the
    // same as every other avatar-bearing response. `toVisibleAvatarUrl` also
    // honours the member's own `photoVisible` toggle, so a spotlighted member
    // who has turned their photo off still ships with a null avatar here.
    avatarUrl: toVisibleAvatarUrl(profile),
    quote: copy.quote,
    tags: profile.tags,
  };
}

/** A community owner/member resolved to a public roster face. */
export function toLandingCommunityFace(
  profile: Profile,
): LandingCommunityFaceDTO {
  return {
    name: `${profile.firstName} ${profile.lastName}`,
    avatarUrl: toVisibleAvatarUrl(profile),
  };
}

export function toLandingCommunityFeatureDTO(
  feature: LandingFeature,
  community: Community,
  memberCount: number,
  owner: Profile | null,
  faces: LandingCommunityFaceDTO[],
): LandingCommunityFeatureDTO {
  const copy = feature.copy as { blurb?: string };
  return {
    id: feature.id,
    slug: community.slug,
    name: community.name,
    memberCount,
    blurb: copy.blurb ?? null,
    coverImageUrl: toImageUrl(community.coverImageUrl),
    category: community.type,
    accessTier: community.accessTier,
    foundedYear: community.createdAt.getFullYear(),
    features: community.features,
    owner: owner ? toLandingCommunityFace(owner) : null,
    faces,
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

export function toLandingGatheringFeatureDTO(
  feature: LandingFeature,
  event: Event,
): LandingGatheringFeatureDTO {
  const copy = feature.copy as { blurb?: string };
  return {
    id: feature.id,
    slug: event.slug,
    title: event.title,
    startAt: event.startAt.toISOString(),
    timezone: event.timezone,
    area: event.neighbourhood,
    isOnline: event.isOnline,
    coverImageUrl: toImageUrl(event.coverImageUrl),
    blurb: copy.blurb ?? null,
  };
}

export function toLandingStoryFeatureDTO(
  feature: LandingFeature,
  article: MagazineArticle,
  author: MagazineAuthor,
): LandingStoryFeatureDTO {
  const copy = feature.copy as { blurb?: string };
  return {
    id: feature.id,
    slug: article.slug,
    title: article.title,
    dek: article.dek,
    coverImageUrl: toImageUrl(article.heroImageKey),
    authorName: author.name,
    readMinutes: article.readMinutes,
    blurb: copy.blurb ?? null,
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
  return { targetId, slug, name, avatarUrl: toImageUrl(avatarUrl) };
}
