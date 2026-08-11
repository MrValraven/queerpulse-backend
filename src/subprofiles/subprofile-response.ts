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
  type SkinData,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
  type GigState,
  type ItemStructured,
  type WorkState,
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
  // Personas redesign Phase 0 (design plan "Shared Contract").
  venue: string | null;
  doors: string | null;
  ticketUrl: string | null;
  gigState: GigState | null;
  medium: string | null;
  dimensions: string | null;
  edition: string | null;
  workState: WorkState | null;
  structured: ItemStructured | null;
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

// Owner-only follower row — GET /subprofiles/:id/followers, visible ONLY to a
// co-owner of the persona (the endpoint 403s every non-owner). Unlike
// `EndorserView` there is no `note` field: following carries no note.
export interface FollowerView {
  slug: string;
  name: string;
  avatarUrl: string | null;
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
  // Personas redesign Phase 0 (design plan "Shared Contract").
  skinData?: SkinData | null;
  // Personas redesign Phase 2 (dashboard plan Decision §5): the persona's
  // true co-owner headcount (creator + every invited/accepted co-owner), so
  // the owner dashboard's `SideCard` can show a "co-owned by N" badge without
  // an N+1 `listMembers` fetch per card. The creator always holds a
  // `subprofile_members` row from the moment the persona is created (see
  // `SubprofilesService.create`), so this is never less than 1.
  memberCount: number;
}

// Personas redesign Phase 1b (design plan Task 1 Shared Contract): the signal
// a restricted (403) public persona read returns, mirrored verbatim by the
// frontend. `removed` reflects the persona's own `removedAt` — nothing sets
// that column yet (the admin takedown action is a separate, later feature;
// see the migration's DO-NOT-RUN comment).
export type RestrictedState = 'private' | 'members_only' | 'removed';

export interface RestrictedAccessBody {
  restrictedState: RestrictedState;
}

// Builds the exact 403 response body the Shared Contract requires — pass
// straight to `new ForbiddenException(...)` so Nest serialises it verbatim.
export function restrictedAccessBody(
  state: RestrictedState,
): RestrictedAccessBody {
  return { restrictedState: state };
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
  // Personas redesign Phase 1b: present so an owner/co-owner viewing their own
  // unpublished persona through the public read can tell it's a draft (drives
  // the frontend's `SubprofileDraftBanner`). For every non-owner viewer this
  // is always `published` — `resolvePublicAccess` 404s anything else before a
  // DTO is ever built for them.
  status: SubprofileStatus;
  items: SubprofileItemView[];
  socialLinks: SocialLinkView[];
  endorsementCount: number;
  viewerEndorsed: boolean;
  followerCount: number;
  viewerFollowing: boolean;
  affiliations: AffiliationView[];
  ownerSlug?: string; // linked only
  ownerName?: string; // linked only
  // Is the current viewer a co-owner (creator or invited member) of THIS
  // persona? Lets the frontend show the "edit" affordance on a co-owner's
  // nested persona even when viewing a co-owner's profile, without an N+1
  // members fetch per card.
  viewerIsMember: boolean;
  // Personas redesign Phase 0 (design plan "Shared Contract"). Display data —
  // present on the public view for BOTH linked and unlinked personas (not
  // identifying).
  skinData?: SkinData | null;
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
  // Personas redesign Phase 4 (design plan Decision §3): batched from
  // `SubprofileFollowersService.loadFollowerCountsFor` in the directory list
  // path (ONE grouped query, never per-card) — mirrors `socialCount`/`tags`.
  followerCount: number;
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
    venue: item.venue ?? null,
    doors: item.doors ?? null,
    ticketUrl: item.ticketUrl ?? null,
    gigState: item.gigState ?? null,
    medium: item.medium ?? null,
    dimensions: item.dimensions ?? null,
    edition: item.edition ?? null,
    workState: item.workState ?? null,
    structured: item.structured ?? null,
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
  memberCount = 1,
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
    skinData: subprofile.skinData ?? null,
    memberCount,
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
  viewerIsMember = false,
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
    status: subprofile.status,
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
    viewerIsMember,
    skinData: subprofile.skinData ?? null,
  };
  // Owner identity is exposed ONLY for linked personas — never leak the tie for
  // an unlinked (pseudonymous) persona (design spec §4).
  if (subprofile.linkVisibility === SubprofileLinkVisibility.Linked && owner) {
    view.ownerSlug = owner.slug;
    view.ownerName = owner.name;
  }
  return view;
}

/**
 * Lightweight row for the cross-entity global search (`SearchService`) — only
 * standalone (unlinked) personas ever reach it, so the public `handle` is the
 * identifier and no owner tie is exposed. Mapped to a `SearchResultDTO` by
 * hand in `search/search-response.ts`.
 */
export interface SubprofileSearchRow {
  handle: string;
  displayName: string;
  tagline: string | null;
  kind: SubprofileKind;
}

export function toSubprofileSearchRow(
  subprofile: Subprofile,
): SubprofileSearchRow {
  return {
    handle: subprofile.handle ?? '',
    displayName: subprofile.displayName,
    tagline: subprofile.tagline,
    kind: subprofile.kind,
  };
}

export function toCardDTO(
  subprofile: Subprofile,
  socialCount = 0,
  tags: string[] = [],
  followerCount = 0,
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
    followerCount,
  };
}
