import {
  ConflictException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FeatureKey, isFeatureLaunched } from '../launchedFeatures';

/** Every kind the admin page lists. Wire values, also the `:kind` path segment. */
export const CREATOR_DRAFT_KINDS = [
  'persona',
  'studio_release',
  'studio_episode',
  'listing',
  'event',
  'listing_edit',
  'community',
] as const;
export type CreatorDraftKind = (typeof CREATOR_DRAFT_KINDS)[number];

/** Identity map, handed to `ParseEnumPipe`. */
export const CREATOR_DRAFT_KIND_VALUES: {
  readonly [K in CreatorDraftKind]: K;
} = {
  persona: 'persona',
  studio_release: 'studio_release',
  studio_episode: 'studio_episode',
  listing: 'listing',
  event: 'event',
  listing_edit: 'listing_edit',
  community: 'community',
};

/** The three kinds stored in the `creator_drafts` table. */
export const STORED_CREATOR_DRAFT_KINDS = [
  'event',
  'listing_edit',
  'community',
] as const;
export type StoredCreatorDraftKind =
  (typeof STORED_CREATOR_DRAFT_KINDS)[number];

/** `listing` is exempt from the notice date. */
export type NoticeGatedCreatorDraftKind = Exclude<CreatorDraftKind, 'listing'>;

/**
 * ISO instant from which a kind shows to staff (a row shows only when saved at
 * or after it). `null` keeps the kind out of the list and the detail. The
 * coordinator sets each date in the batch that ships that kind's note; the
 * Studio kinds share one date.
 *
 * The three stored kinds live in the new `creator_drafts` table, so every row
 * there was saved under the note: their date is the day the table shipped.
 */
export const CREATOR_DRAFT_NOTICE_LIVE_SINCE: Readonly<
  Record<NoticeGatedCreatorDraftKind, string | null>
> = {
  // Persona and the two Studio kinds are set to the production frontend
  // deploy instant in the deploy batch (the moment their note goes live).
  persona: null,
  studio_release: null,
  studio_episode: null,
  event: '2026-10-19T00:00:00Z',
  listing_edit: '2026-10-19T00:00:00Z',
  community: '2026-10-19T00:00:00Z',
};

export const CREATOR_DRAFT_KIND_FEATURE: Readonly<
  Record<CreatorDraftKind, FeatureKey | null>
> = {
  persona: null,
  studio_release: 'studio',
  studio_episode: 'studio',
  listing: 'listings',
  listing_edit: 'listings',
  event: 'events',
  community: 'communities',
};

export const CREATOR_DRAFT_LIMITS = {
  payloadMaxBytes: 98_304,
  payloadVersionMax: 1000,
  progressTotalMax: 50,
  missingCodesMax: 50,
  missingCodeMaxLength: 64,
  listingRefMaxLength: 64,
  communitySlugMaxLength: 120,
} as const;

/** Mirrors the frontend wizard's `TOTAL_STEPS`. */
export const LISTING_WIZARD_TOTAL_STEPS = 6;
export const DEFAULT_CREATOR_DRAFT_RETENTION_DAYS = 90;

export const CREATOR_DRAFT_VIEWED_ACTION = 'creator_draft_viewed';

/** What decides whether a kind is visible to staff right now. Injectable so a
 * spec can move the notice dates and the feature switches. */
export interface CreatorDraftVisibility {
  noticeLiveSince: Readonly<Record<NoticeGatedCreatorDraftKind, string | null>>;
  isFeatureLaunched(feature: FeatureKey): boolean;
}

export const CREATOR_DRAFT_VISIBILITY = Symbol('CREATOR_DRAFT_VISIBILITY');

export const DEFAULT_CREATOR_DRAFT_VISIBILITY: CreatorDraftVisibility = {
  noticeLiveSince: CREATOR_DRAFT_NOTICE_LIVE_SINCE,
  isFeatureLaunched,
};

export type CreatorDraftErrorCode =
  | 'creator_draft_not_found'
  | 'creator_draft_listing_unavailable'
  | 'creator_draft_revision_conflict'
  | 'creator_draft_too_large';

const CREATOR_DRAFT_MESSAGES: Record<CreatorDraftErrorCode, string> = {
  creator_draft_not_found: 'This draft is not available.',
  creator_draft_listing_unavailable: 'This listing is not one you can edit.',
  creator_draft_revision_conflict:
    'This draft changed in another tab or device.',
  creator_draft_too_large: 'This draft is too large to save.',
};

export function creatorDraftError(
  code: Exclude<CreatorDraftErrorCode, 'creator_draft_revision_conflict'>,
): HttpException {
  const body = { code, message: CREATOR_DRAFT_MESSAGES[code] };
  return code === 'creator_draft_too_large'
    ? new PayloadTooLargeException(body)
    : new NotFoundException(body);
}

export function creatorDraftRevisionConflict(current: {
  revision: number | null;
  savedAt: string | null;
}): ConflictException {
  return new ConflictException({
    code: 'creator_draft_revision_conflict',
    message: CREATOR_DRAFT_MESSAGES.creator_draft_revision_conflict,
    revision: current.revision,
    savedAt: current.savedAt,
  });
}
