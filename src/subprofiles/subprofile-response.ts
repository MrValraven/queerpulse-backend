// Pure entity → wire-view mappers. Shapes are IDENTICAL to GLOBAL CONTRACT C3
// (mirrored by the frontend `subprofiles.api.ts` types) so the API and UI never
// drift. No DB access, no side effects — safe to unit-test directly.

import { toImageUrl } from '../common/image-url';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';

export interface SubprofileItemView {
  section: SubprofileSection;
  title: string;
  subtitle: string | null;
  description: string | null;
  url: string | null;
  imageUrl: string | null;
  date: string | null;
  meta: string | null;
  tags: string[];
  isFeatured: boolean;
  collaborators: CollaboratorView[];
}

// Resolved collaboration credit — exposed for BOTH linked and unlinked
// personas (a collaborator names someone else, not the owner; anonymity-safe).
export interface CollaboratorView {
  handle: string;
  type: 'member' | 'persona';
  name: string;
  avatarUrl: string | null;
  slug: string | null; // member profile slug for /members/:slug; null for personas (use handle)
}

export interface SocialLinkView {
  platform: string;
  urlOrHandle: string;
}

export interface EndorserView {
  slug: string;
  name: string;
  avatarUrl: string | null;
  note: string | null;
}

// Resolved event/community link — exposed for BOTH linked and unlinked
// personas (persona → entity, not owner; anonymity-safe).
export interface AffiliationView {
  targetType: string;
  targetSlug: string;
  role: string;
  name: string;
  imageUrl: string | null;
}

// Owner-facing (full) view — GET /subprofiles/mine, GET /subprofiles/:id, and
// every mutation.
export interface SubprofileView {
  id: string;
  kind: SubprofileKind;
  slug: string;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
  tagline: string | null;
  bio: string | null;
  coverUrl: string | null;
  accent: string | null;
  availability: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  linkVisibility: SubprofileLinkVisibility;
  visibility: SubprofileVisibility;
  status: SubprofileStatus;
  position: number;
  items: SubprofileItemView[];
  socialLinks: SocialLinkView[];
  endorsementCount: number;
  followerCount: number;
  affiliations: AffiliationView[];
}

// Public view — owner identity is stripped when the persona is `unlinked`.
export interface SubprofilePublicView {
  id: string; // non-identifying uuid; safe to expose for linked + unlinked
  kind: SubprofileKind;
  slug: string;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
  tagline: string | null;
  bio: string | null;
  coverUrl: string | null;
  accent: string | null;
  availability: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  linkVisibility: SubprofileLinkVisibility;
  items: SubprofileItemView[];
  socialLinks: SocialLinkView[];
  endorsementCount: number;
  viewerEndorsed: boolean;
  followerCount: number;
  viewerFollowing: boolean;
  affiliations: AffiliationView[];
  ownerSlug?: string; // linked only
  ownerName?: string; // linked only
}

// Directory / list card.
export interface SubprofileCardView {
  handle: string;
  kind: SubprofileKind;
  displayName: string;
  avatarUrl: string | null;
  tagline: string | null;
  accent: string | null;
  availability: string | null;
  socialCount: number;
  tags: string[];
}

export interface SubprofileOwnerRef {
  slug: string;
  name: string;
}

function toItemView(
  item: SubprofileItem,
  collaboratorsByHandle: Map<string, CollaboratorView> = new Map(),
): SubprofileItemView {
  return {
    section: item.section,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    url: item.url,
    imageUrl: toImageUrl(item.imageUrl),
    date: item.date,
    meta: item.meta,
    tags: item.tags ?? [],
    isFeatured:
      item.section === SubprofileSection.Links ? false : item.isFeatured,
    collaborators: (item.collaborators ?? [])
      .map((handle) => collaboratorsByHandle.get(handle))
      .filter((view): view is CollaboratorView => Boolean(view)),
  };
}

function toSocialLinkView(link: SubprofileSocialLink): SocialLinkView {
  return { platform: link.platform, urlOrHandle: link.urlOrHandle };
}

// Items ordered by (section, position) per C3.
function sortItems(items: SubprofileItem[]): SubprofileItem[] {
  return [...items].sort((a, b) => {
    if (a.section !== b.section) {
      return a.section < b.section ? -1 : 1;
    }
    return a.position - b.position;
  });
}

// Social links ordered by position per C3.
function sortSocialLinks(
  socialLinks: SubprofileSocialLink[],
): SubprofileSocialLink[] {
  return [...socialLinks].sort((a, b) => a.position - b.position);
}

export function toSubprofileDTO(
  subprofile: Subprofile,
  items: SubprofileItem[],
  socialLinks: SubprofileSocialLink[] = [],
  endorsementCount = 0,
  followerCount = 0,
  affiliations: AffiliationView[] = [],
  collaboratorsByHandle: Map<string, CollaboratorView> = new Map(),
): SubprofileView {
  return {
    id: subprofile.id,
    kind: subprofile.kind,
    slug: subprofile.slug,
    handle: subprofile.handle,
    displayName: subprofile.displayName,
    avatarUrl: toImageUrl(subprofile.avatarUrl),
    tagline: subprofile.tagline,
    bio: subprofile.bio,
    coverUrl: toImageUrl(subprofile.coverUrl),
    accent: subprofile.accent,
    availability: subprofile.availability,
    ctaLabel: subprofile.ctaLabel,
    ctaUrl: subprofile.ctaUrl,
    linkVisibility: subprofile.linkVisibility,
    visibility: subprofile.visibility,
    status: subprofile.status,
    position: subprofile.position,
    items: sortItems(items).map((item) =>
      toItemView(item, collaboratorsByHandle),
    ),
    socialLinks: sortSocialLinks(socialLinks).map(toSocialLinkView),
    endorsementCount,
    followerCount,
    affiliations,
  };
}

export function toPublicDTO(
  subprofile: Subprofile,
  items: SubprofileItem[],
  owner?: SubprofileOwnerRef,
  socialLinks: SubprofileSocialLink[] = [],
  endorsementCount = 0,
  viewerEndorsed = false,
  followerCount = 0,
  viewerFollowing = false,
  affiliations: AffiliationView[] = [],
  collaboratorsByHandle: Map<string, CollaboratorView> = new Map(),
): SubprofilePublicView {
  const view: SubprofilePublicView = {
    id: subprofile.id,
    kind: subprofile.kind,
    slug: subprofile.slug,
    handle: subprofile.handle,
    displayName: subprofile.displayName,
    avatarUrl: toImageUrl(subprofile.avatarUrl),
    tagline: subprofile.tagline,
    bio: subprofile.bio,
    // Cover/accent/availability/CTA/socialLinks are persona-owned presence
    // fields — never identifying — so they are exposed here for BOTH linked
    // and unlinked personas. Only ownerSlug/ownerName (below) stay linked-only.
    coverUrl: toImageUrl(subprofile.coverUrl),
    accent: subprofile.accent,
    availability: subprofile.availability,
    ctaLabel: subprofile.ctaLabel,
    ctaUrl: subprofile.ctaUrl,
    linkVisibility: subprofile.linkVisibility,
    items: sortItems(items).map((item) =>
      toItemView(item, collaboratorsByHandle),
    ),
    socialLinks: sortSocialLinks(socialLinks).map(toSocialLinkView),
    // endorsementCount/viewerEndorsed/followerCount/viewerFollowing are
    // exposed for BOTH linked and unlinked personas — the id is a
    // non-identifying uuid, and endorsement/follower state is not
    // identifying either (follower identities are never exposed — count
    // only). Only ownerSlug/ownerName (below) stay linked-only.
    endorsementCount,
    viewerEndorsed,
    followerCount,
    viewerFollowing,
    affiliations,
  };
  // Owner identity is exposed ONLY for linked personas — never leak the tie for
  // an unlinked (pseudonymous) persona (design spec §4).
  if (subprofile.linkVisibility === SubprofileLinkVisibility.Linked && owner) {
    view.ownerSlug = owner.slug;
    view.ownerName = owner.name;
  }
  return view;
}

export function toCardDTO(
  subprofile: Subprofile,
  socialCount = 0,
  tags: string[] = [],
): SubprofileCardView {
  return {
    handle: subprofile.handle ?? '',
    kind: subprofile.kind,
    displayName: subprofile.displayName,
    avatarUrl: toImageUrl(subprofile.avatarUrl),
    tagline: subprofile.tagline,
    accent: subprofile.accent,
    availability: subprofile.availability,
    socialCount,
    tags,
  };
}
