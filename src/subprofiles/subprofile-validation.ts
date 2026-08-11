// Publish-gating validation for subprofiles (design spec §4, GLOBAL CONTRACT
// C5). Everything here is a pure, side-effect-free helper so the rules can be
// unit-tested in isolation (see `subprofiles.service.spec.ts`). The service
// wires the async bits (handle-uniqueness lookup) and feeds the result in.

import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { HANDLE_RE, RESERVED_HANDLES } from '../common/handles';
import { BLOCKED_TERMS, textHasBlockedTerm } from '../common/blocked-terms';

// --- C5 constants (must stay identical to the frontend mirror) --------------
// `HANDLE_RE` and `RESERVED_HANDLES` now live in the shared handle module
// (design plan PART C / UC1) so the ONE global namespace is governed by a single
// source of truth. Re-exported here so existing importers keep working (they are
// also used locally by `validatePublish` below).
export { HANDLE_RE, RESERVED_HANDLES };

export const MIN_BIO = 80; // characters
export const MIN_CONTENT_ITEMS = 3; // items in sections other than `links`
export const MAX_SUBPROFILES = 12; // per user
export const MAX_ITEMS_PER_SECTION = 100;

// The universal `gallery` section (every kind, added just before `links` by
// `sectionsForKind`) is capped much tighter than a generic content section —
// it's a photo strip, not a portfolio list.
export const MAX_GALLERY_PHOTOS = 6;

// A persona can have at most this many co-owners (creator + invited members).
export const MAX_SUBPROFILE_CO_OWNERS = 5;

// The persona name/tagline slur screen now uses the centrally-managed blocklist
// in `src/common/blocked-terms.ts` (word-boundary matching, single source of
// truth) rather than the former inert 2-item placeholder array. Re-exported so
// existing importers keep resolving `BLOCKED_TERMS` from here.
export { BLOCKED_TERMS };

// Exact publish-unmet codes consumed by the FE checklist (GLOBAL CONTRACT C5).
export type PublishUnmetCode =
  | 'handle_invalid'
  | 'handle_taken'
  | 'handle_reserved'
  | 'avatar_missing'
  | 'bio_too_short'
  | 'not_enough_items'
  | 'blocked_terms';

function containsBlockedTerm(sp: Subprofile): boolean {
  return textHasBlockedTerm(sp.displayName, sp.bio, sp.handle);
}

/**
 * Runs the completeness check for publishing a subprofile and returns the list
 * of unmet requirement codes (empty === may publish).
 *
 * - **Linked** personas only require a non-empty `display_name` (guaranteed at
 *   create/update); they render nested and never claim a handle, so the handle/
 *   avatar/bio/items checks are skipped (design spec §4).
 * - **Unlinked** personas must pass the full automated completeness check.
 *
 * `handleTaken` is supplied by the caller (the service queries the partial
 * unique `handle` index) so this function stays synchronous and pure.
 */
export function validatePublish(
  sp: Subprofile,
  items: SubprofileItem[],
  handleTaken = false,
): PublishUnmetCode[] {
  if (sp.linkVisibility === SubprofileLinkVisibility.Linked) {
    return [];
  }

  const unmet: PublishUnmetCode[] = [];

  const handle = sp.handle;
  if (!handle || !HANDLE_RE.test(handle)) {
    unmet.push('handle_invalid');
  } else if (RESERVED_HANDLES.includes(handle)) {
    unmet.push('handle_reserved');
  } else if (handleTaken) {
    unmet.push('handle_taken');
  }

  if (!sp.avatarUrl) {
    unmet.push('avatar_missing');
  }

  if (!sp.bio || sp.bio.trim().length < MIN_BIO) {
    unmet.push('bio_too_short');
  }

  const contentItems = items.filter(
    (it) => it.section !== SubprofileSection.Links,
  ).length;
  if (contentItems < MIN_CONTENT_ITEMS) {
    unmet.push('not_enough_items');
  }

  if (containsBlockedTerm(sp)) {
    unmet.push('blocked_terms');
  }

  return unmet;
}

/**
 * Per-owner slug from a display name: lowercase, non-alphanumerics → single
 * dashes, trimmed. The numeric suffix on `UNIQUE(user_id, slug)` collisions is
 * applied by the service, not here.
 */
export function slugifyDisplayName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'subprofile';
}

// --- Identity & presence constants (design plan Task A2; must stay identical
// to the frontend mirror) ----------------------------------------------------

// Curated accent-palette keys — each maps to an existing brand color token on
// the frontend (plum → --plum, coral → --accent, jade → --jade, amber →
// --amber, violet → --violet). Only brand hues with tuned light+dark variants,
// so no hardcoded hex is ever needed (design-system: tokens only).
export const ACCENT_KEYS = [
  'plum',
  'coral',
  'jade',
  'amber',
  'violet',
] as const;
export const AVAILABILITY_KEYS = [
  'open_to_collabs',
  'booking',
  'not_available',
] as const;
export const KNOWN_PLATFORM_KEYS = [
  'website',
  'instagram',
  'x',
  'bluesky',
  'mastodon',
  'linkedin',
  'github',
  'dribbble',
  'behance',
  'youtube',
  'tiktok',
  'letterboxd',
  'backloggd',
  'goodreads',
  'email',
  'other',
  'bandcamp',
  'soundcloud',
  'spotify',
  'twitch',
  'imdb',
  'artstation',
  'kofi',
  'patreon',
] as const;
export const MAX_SOCIAL_LINKS = 20;
export const MAX_CTA_LABEL = 40;

/** Returns true if a social-links payload is valid (platform known, non-empty, capped). */
export function validateSocialLinks(
  items: { platform: string; urlOrHandle: string }[],
): boolean {
  if (items.length > MAX_SOCIAL_LINKS) return false;
  return items.every(
    (item) =>
      KNOWN_PLATFORM_KEYS.includes(
        item.platform as (typeof KNOWN_PLATFORM_KEYS)[number],
      ) && item.urlOrHandle.trim().length > 0,
  );
}

// --- Affiliations (design plan Phase 3c Task A2; must stay identical to the
// frontend mirror) ------------------------------------------------------------

export const AFFILIATION_TARGET_TYPES = ['event', 'community'] as const;
export const EVENT_ROLES = ['performing', 'attending', 'hosting'] as const;
export const COMMUNITY_ROLES = ['member', 'mod', 'founder'] as const;
export const MAX_AFFILIATIONS = 12;

// --- Collaboration credits (design plan Phase 3d Task A2; must stay
// identical to the frontend mirror) ------------------------------------------

export const MAX_COLLABORATORS_PER_ITEM = 10;

export function rolesForTargetType(targetType: string): readonly string[] {
  if (targetType === 'event') return EVENT_ROLES;
  if (targetType === 'community') return COMMUNITY_ROLES;
  return [];
}
export function isValidAffiliation(item: {
  targetType: string;
  role: string;
}): boolean {
  return (
    AFFILIATION_TARGET_TYPES.includes(
      item.targetType as (typeof AFFILIATION_TARGET_TYPES)[number],
    ) && rolesForTargetType(item.targetType).includes(item.role)
  );
}
