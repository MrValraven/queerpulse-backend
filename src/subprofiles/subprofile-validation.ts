// Publish-gating validation for subprofiles (design spec §4, GLOBAL CONTRACT
// C5). Everything here is a pure, side-effect-free helper so the rules can be
// unit-tested in isolation (see `subprofiles.service.spec.ts`). The service
// wires the async bits (handle-uniqueness lookup) and feeds the result in.

import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { SubprofileItem } from './entities/subprofile-item.entity';
import { HANDLE_RE, RESERVED_HANDLES } from '../common/handles';
import { BLOCKED_TERMS, textHasBlockedTerm } from '../common/blocked-terms';
import { handleIsKindName, handleNamesOwner } from './persona-handle';
import type { SubprofileKind } from './subprofile-kinds';

// --- C5 constants (must stay identical to the frontend mirror) --------------
// `HANDLE_RE` and `RESERVED_HANDLES` now live in the shared handle module
// (design plan PART C / UC1) so the ONE global namespace is governed by a single
// source of truth. Re-exported here so existing importers keep working (they are
// also used locally by `validatePublish` below).
export { HANDLE_RE, RESERVED_HANDLES };

export const MIN_BIO = 80; // characters
// Items in sections other than `links`. ADVISORY ONLY: an owner may publish a
// persona with no content at all (the frontend shows "add a few pieces" as an
// optional polish nudge, never as a publish gate), so `validatePublish` no
// longer reads this. Kept exported because the frontend mirrors the same
// threshold for that nudge, and the `not_enough_items` code stays in the C5
// union below for older clients.
export const MIN_CONTENT_ITEMS = 3;
export const MAX_SUBPROFILES = 12; // per user
// Upper bound on the `ids` array of `PUT /subprofiles/order`. Deliberately
// NOT `MAX_SUBPROFILES`: that cap counts personas a member CREATED (see the
// `count(Subprofile, { where: { userId } })` check in `SubprofilesService.
// create`), while a reorder names every row in `subprofile_members`, which
// also holds the personas a member co-owns by accepting an invite. Nothing
// bounds how many invites a member may accept, so capping the request at 12
// would hand a member who created 12 personas and accepted even one invite a
// permanent 400 on a request that was correct.
//
// This is a request-shape guard against an absurd body, not a domain rule.
// The domain rule is the exact equality against the caller's own membership
// count in `SubprofilesService.reorderMine`, which is the only place that
// knows what the caller actually belongs to.
export const MAX_REORDERABLE_PERSONAS = 200;
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
  | 'handle_names_owner'
  | 'handle_is_kind'
  | 'avatar_missing'
  | 'bio_too_short'
  | 'not_enough_items'
  | 'blocked_terms';

function containsBlockedTerm(sp: Subprofile): boolean {
  return textHasBlockedTerm(sp.displayName, sp.bio, sp.handle);
}

// The three namespace checks every claimed handle passes, for both link kinds.
// A linked persona's typed handle runs them through `linkedHandleUnmetCodes`.
export function handleUnmetCodes(
  handle: string | null,
  handleTaken: boolean,
): PublishUnmetCode[] {
  if (!handle || !HANDLE_RE.test(handle)) {
    return ['handle_invalid'];
  }
  if (RESERVED_HANDLES.includes(handle)) {
    return ['handle_reserved'];
  }
  if (handleTaken) {
    return ['handle_taken'];
  }
  return [];
}

// The checks a handle the owner typed on a LINKED persona passes: the three
// namespace checks, plus the blocked-term screen on the handle alone. The
// handle is a public `/p/` address, so it is screened like an unlinked
// persona's; the rest of a linked persona's text keeps skipping the screen
// (design spec §4.2). When `kind` is given, a handle that passes the namespace
// checks yet is only the persona's own kind name ("therapist") is refused with
// `handle_is_kind`. Exported for the link switch in
// `SubprofilesService.update`, which claims a typed handle outside
// `validatePublish`.
export function linkedHandleUnmetCodes(
  handle: string,
  handleTaken: boolean,
  kind?: SubprofileKind,
): PublishUnmetCode[] {
  const unmet = handleUnmetCodes(handle, handleTaken);
  if (unmet.length === 0 && kind && handleIsKindName(handle, kind)) {
    unmet.push('handle_is_kind');
  }
  if (textHasBlockedTerm(handle)) {
    unmet.push('blocked_terms');
  }
  return unmet;
}

/**
 * Runs the completeness check for publishing a subprofile and returns the list
 * of unmet requirement codes (empty === may publish).
 *
 * - **Linked** personas claim a `/p/<handle>` too. With no handle the server
 *   derives one at publish (`<creatorSlug>-<personaSlug>`), so a null handle
 *   passes. A handle the owner typed runs the three handle checks (invalid,
 *   reserved, taken), the kind-name check (`handle_is_kind`) and the
 *   blocked-term screen on the handle alone, since it is a public address;
 *   the avatar and bio checks, and the blocked-term screen on the rest of the
 *   text, stay unlinked-only (design spec §4.2).
 * - **Unlinked** personas must pass the full automated completeness check.
 *   Their handle also may not carry the creator's profile slug
 *   (`handle_names_owner`, checked when `creatorSlug` is supplied), since that
 *   would say who runs a pseudonymous persona.
 * - For both link kinds, a handle that is only the persona's own kind name
 *   ("therapist", "terapia") is refused with `handle_is_kind`: a `/p/`
 *   address has to name the persona itself.
 *
 * Content items are NOT part of that check: a persona may go live empty and
 * fill up afterwards, so `not_enough_items` is never emitted and `_items` goes
 * unread. The parameter stays so every existing caller keeps compiling, and the
 * frontend carries the same threshold as an optional "add a few pieces" nudge.
 *
 * `handleTaken` is supplied by the caller (the service asks the handles
 * registry) so this function stays synchronous and pure. `creatorSlug` is the
 * persona CREATOR's `profiles.slug`, also looked up by the caller.
 */
export function validatePublish(
  sp: Subprofile,
  _items: SubprofileItem[],
  handleTaken = false,
  creatorSlug: string | null = null,
): PublishUnmetCode[] {
  if (sp.linkVisibility === SubprofileLinkVisibility.Linked) {
    return sp.handle
      ? linkedHandleUnmetCodes(sp.handle, handleTaken, sp.kind)
      : [];
  }

  const handle = sp.handle;
  const unmet = handleUnmetCodes(handle, handleTaken);
  if (
    unmet.length === 0 &&
    handle &&
    creatorSlug &&
    handleNamesOwner(handle, creatorSlug)
  ) {
    unmet.push('handle_names_owner');
  }
  if (unmet.length === 0 && handle && handleIsKindName(handle, sp.kind)) {
    unmet.push('handle_is_kind');
  }

  if (!sp.avatarUrl) {
    unmet.push('avatar_missing');
  }

  if (!sp.bio || sp.bio.trim().length < MIN_BIO) {
    unmet.push('bio_too_short');
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
