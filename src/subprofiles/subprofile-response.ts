// Pure entity → wire-view mappers. Shapes are IDENTICAL to GLOBAL CONTRACT C3
// (mirrored by the frontend `subprofiles.api.ts` types) so the API and UI never
// drift. No DB access, no side effects — safe to unit-test directly.

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
  linkVisibility: SubprofileLinkVisibility;
  visibility: SubprofileVisibility;
  status: SubprofileStatus;
  position: number;
  items: SubprofileItemView[];
}

// Public view — owner identity is stripped when the persona is `unlinked`.
export interface SubprofilePublicView {
  kind: SubprofileKind;
  slug: string;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
  tagline: string | null;
  bio: string | null;
  linkVisibility: SubprofileLinkVisibility;
  items: SubprofileItemView[];
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
}

export interface SubprofileOwnerRef {
  slug: string;
  name: string;
}

function toItemView(it: SubprofileItem): SubprofileItemView {
  return {
    section: it.section,
    title: it.title,
    subtitle: it.subtitle,
    description: it.description,
    url: it.url,
    imageUrl: it.imageUrl,
    date: it.date,
    meta: it.meta,
    tags: it.tags ?? [],
  };
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

export function toSubprofileDTO(
  sp: Subprofile,
  items: SubprofileItem[],
): SubprofileView {
  return {
    id: sp.id,
    kind: sp.kind,
    slug: sp.slug,
    handle: sp.handle,
    displayName: sp.displayName,
    avatarUrl: sp.avatarUrl,
    tagline: sp.tagline,
    bio: sp.bio,
    linkVisibility: sp.linkVisibility,
    visibility: sp.visibility,
    status: sp.status,
    position: sp.position,
    items: sortItems(items).map(toItemView),
  };
}

export function toPublicDTO(
  sp: Subprofile,
  items: SubprofileItem[],
  owner?: SubprofileOwnerRef,
): SubprofilePublicView {
  const view: SubprofilePublicView = {
    kind: sp.kind,
    slug: sp.slug,
    handle: sp.handle,
    displayName: sp.displayName,
    avatarUrl: sp.avatarUrl,
    tagline: sp.tagline,
    bio: sp.bio,
    linkVisibility: sp.linkVisibility,
    items: sortItems(items).map(toItemView),
  };
  // Owner identity is exposed ONLY for linked personas — never leak the tie for
  // an unlinked (pseudonymous) persona (design spec §4).
  if (sp.linkVisibility === SubprofileLinkVisibility.Linked && owner) {
    view.ownerSlug = owner.slug;
    view.ownerName = owner.name;
  }
  return view;
}

export function toCardDTO(sp: Subprofile): SubprofileCardView {
  return {
    handle: sp.handle ?? '',
    kind: sp.kind,
    displayName: sp.displayName,
    avatarUrl: sp.avatarUrl,
    tagline: sp.tagline,
  };
}
