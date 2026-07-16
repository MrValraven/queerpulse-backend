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

// Placeholder blocklist for v1. FOLLOW-UP: replace this static list with a hook
// into the dedicated `moderation` module so terms are centrally managed and the
// list is not duplicated per feature (documented non-goal in design spec §4/§8).
export const BLOCKED_TERMS = ['slur-placeholder-1', 'slur-placeholder-2'];

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
  const haystack = [sp.displayName, sp.bio ?? '', sp.handle ?? '']
    .join(' ')
    .toLowerCase();
  return BLOCKED_TERMS.some((term) => haystack.includes(term.toLowerCase()));
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
