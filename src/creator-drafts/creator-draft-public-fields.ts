import { toImageUrl } from '../common/image-url';
import {
  DEFAULT_LISTING_MENU_CURRENCY,
  LISTING_MENU_CURRENCIES,
} from '../listings/dto/create-listing.dto';
import { LISTING_DRAFT_BUSINESS_KEYS } from '../listing-drafts/listing-draft-response';
import type {
  CommunityDraftPreview,
  EventDraftPreview,
  ListingDraftPreview,
} from './creator-draft.types';

/**
 * The privacy line of the staff view. A staff preview of a stored draft carries
 * only the fields the published page would show. Each list below names those
 * fields, and a key the frontend adds to a draft later stays hidden until
 * someone adds it here.
 *
 * Payloads are client-written JSON, so every helper checks a value's type
 * before it reads it. An image value leaves through `toImageUrl`, and one it
 * cannot resolve (empty, or neither a storage key nor an https URL) becomes
 * `null`.
 */

/** The event snapshot keys the published event page shows, in contract order. */
export const EVENT_DRAFT_PREVIEW_KEYS = [
  'title',
  'description',
  'family',
  'format',
  'otherText',
  'formatDetails',
  'cap',
  'showAttendeeCount',
  'date',
  'time',
  'endDate',
  'endTime',
  'repeats',
  'cadence',
  'endType',
  'endCount',
  'endUntil',
  'hood',
  'communitySlug',
  'audienceScope',
  'venue',
  'venueListing',
  'lang',
  'cost',
  'costKind',
  'accessibilityAnswers',
  'accessNotes',
  'themes',
  'contentNotes',
  'houseRules',
  'rsvpCutoff',
  'rsvpQuestions',
  'customRsvpQuestion',
  'allowWaitlist',
  'goTogetherEnabled',
] as const;

/** The listing wizard keys the published listing page shows. */
export const LISTING_DRAFT_PREVIEW_KEYS = [
  ...LISTING_DRAFT_BUSINESS_KEYS,
  'coverPhoto',
] as const;

/** The community wizard keys the published community page shows. */
export const COMMUNITY_DRAFT_PREVIEW_KEYS = [
  'name',
  'purpose',
  'type',
  'whoFor',
  'accessTier',
  'features',
  'rules',
  'nowReading',
  'tint',
  'coverImageUrl',
  'avatarImageUrl',
  'tagline',
  'handle',
  'tags',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickAllowed(
  source: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  return picked;
}

function resolveImage(value: unknown): string | null {
  return typeof value === 'string' ? toImageUrl(value) : null;
}

/** The object at `payload.draft`, else `{}`. */
export function readDraftEnvelope(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(payload.draft) ? payload.draft : {};
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Event `venueListing`: a `{ slug, name }` pair of strings, else null. */
function toVenueListingPreview(
  value: unknown,
): { slug: string; name: string } | null {
  if (!isRecord(value)) return null;
  const slug = readText(value.slug);
  const name = readText(value.name);
  return slug !== null && name !== null ? { slug, name } : null;
}

export function toEventDraftPreview(
  payload: Record<string, unknown>,
  refs: {
    community: { slug: string; name: string } | null;
    runByListing: { slug: string; name: string } | null;
  },
): EventDraftPreview {
  const preview = pickAllowed(payload, EVENT_DRAFT_PREVIEW_KEYS);
  if (Object.hasOwn(preview, 'venueListing')) {
    preview.venueListing = toVenueListingPreview(preview.venueListing);
  }
  return {
    ...preview,
    community: refs.community,
    runByListing: refs.runByListing,
  };
}

const LISTING_PHOTO_SLOTS = ['wide', 'd1', 'd2', 'vibe'] as const;

/** Slots limited to the four the page shows; any other shape is null. */
function toPhotosPreview(value: unknown): Record<string, string | null> | null {
  if (!isRecord(value)) return null;
  const resolvedPhotos: Record<string, string | null> = {};
  for (const slot of LISTING_PHOTO_SLOTS) {
    if (Object.hasOwn(value, slot))
      resolvedPhotos[slot] = resolveImage(value[slot]);
  }
  return resolvedPhotos;
}

function toCoverPhotoPreview(
  value: unknown,
): { image: string | null; alt: string } | null {
  if (!isRecord(value)) return null;
  return { image: resolveImage(value.image), alt: readText(value.alt) ?? '' };
}

function toShopItemPhotoPreview(
  value: unknown,
): { image: string | null; alt: string; caption: string } | null {
  if (!isRecord(value)) return null;
  return {
    image: resolveImage(value.image),
    alt: readText(value.alt) ?? '',
    caption: readText(value.caption) ?? '',
  };
}

function toShopItemPreview(
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: readText(item.id) ?? '',
    name: readText(item.name) ?? '',
    price: readText(item.price) ?? '',
    link: readText(item.link) ?? '',
    photo: toShopItemPhotoPreview(item.photo),
  };
}

function toShopItemsPreview(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).map(toShopItemPreview);
}

/**
 * Like `toListingMenuView`: the file URL resolves or the whole file is null,
 * and a missing or unknown currency reads as the default.
 */
function toMenuPreview(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const file = isRecord(value.file) ? value.file : null;
  const fileUrl = file ? resolveImage(file.url) : null;
  return {
    sections: Array.isArray(value.sections) ? value.sections : [],
    link: readText(value.link) ?? '',
    currency:
      LISTING_MENU_CURRENCIES.find((currency) => currency === value.currency) ??
      DEFAULT_LISTING_MENU_CURRENCY,
    file:
      file && fileUrl
        ? {
            url: fileUrl,
            contentType: readText(file.contentType) ?? '',
            fileName: readText(file.fileName) ?? '',
          }
        : null,
  };
}

const LISTING_LOCATION_KEYS = [
  'address',
  'latitude',
  'longitude',
  'hood',
  'geocoded',
] as const;
const LISTING_HOURS_KEYS = ['hours', 'hoursNote', 'hoursExceptions'] as const;

/**
 * Mirrors the frontend payload mapper (`draftToDto.ts`): an online listing and
 * an out-and-about one without a meeting point keep no location; an online
 * listing and a "By appointment only" one keep no hours.
 */
function dropBlankedKeys(
  preview: Record<string, unknown>,
  draft: Record<string, unknown>,
): void {
  const isOnline = draft.online === true;
  const isMobile = !isOnline && draft.mobile === true;
  const hasNoLocation =
    isOnline || (isMobile && draft.hasMeetingPoint !== true);
  const mobileDetails = isRecord(draft.mobileDetails)
    ? draft.mobileDetails
    : {};
  const hasNoHours =
    isOnline || (isMobile && mobileDetails.byAppointment === true);
  if (hasNoLocation) {
    for (const key of LISTING_LOCATION_KEYS) delete preview[key];
  }
  if (hasNoHours) {
    for (const key of LISTING_HOURS_KEYS) delete preview[key];
  }
}

/** Serves both `listing` and `listing_edit`; `baseline` and `step` never leave. */
export function toListingDraftPreview(
  payload: Record<string, unknown>,
): ListingDraftPreview {
  const draft = readDraftEnvelope(payload);
  const preview = pickAllowed(draft, LISTING_DRAFT_PREVIEW_KEYS);
  if (Object.hasOwn(preview, 'photos')) {
    preview.photos = toPhotosPreview(preview.photos);
  }
  if (Object.hasOwn(preview, 'coverPhoto')) {
    preview.coverPhoto = toCoverPhotoPreview(preview.coverPhoto);
  }
  if (Object.hasOwn(preview, 'shopItems')) {
    preview.shopItems = toShopItemsPreview(preview.shopItems);
  }
  if (Object.hasOwn(preview, 'menu')) {
    preview.menu = toMenuPreview(preview.menu);
  }
  dropBlankedKeys(preview, draft);
  return preview;
}

/** Reads the `draft` envelope; `step` stays behind. */
export function toCommunityDraftPreview(
  payload: Record<string, unknown>,
): CommunityDraftPreview {
  const preview = pickAllowed(
    readDraftEnvelope(payload),
    COMMUNITY_DRAFT_PREVIEW_KEYS,
  );
  for (const imageKey of ['coverImageUrl', 'avatarImageUrl'] as const) {
    if (Object.hasOwn(preview, imageKey)) {
      preview[imageKey] = resolveImage(preview[imageKey]);
    }
  }
  return preview;
}
