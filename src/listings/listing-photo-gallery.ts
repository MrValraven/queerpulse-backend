import type { ListingPhotoSet } from './entities/listing.entity';

/**
 * One photo in a listing's ordered gallery.
 *
 * This replaces the four fixed named slots (`wide`/`d1`/`d2`/`vibe`) the
 * `photos` and `alt` jsonb columns used to hold. Those slots could not express
 * three detail shots, five photos, a cover the owner picked, or a caption, and
 * they kept an image and its own alt text in two separate columns that could
 * drift apart. Here every photo carries its own description, and the ORDER of
 * the array is the order the owner arranged: index 0 is the page's lead photo
 * and the card's fallback when no `coverPhoto` is set.
 *
 * The three fields do three different jobs and must stay separate:
 *
 * - `image` is a storage key or an allowed external `https://` URL, validated
 *   by `@IsImageReference()` on `ListingGalleryPhotoDto`.
 * - `alt` describes the picture for someone who cannot see it. It is an
 *   accessibility requirement, never shown next to the photo, and never
 *   optional on the wire (see `ListingGalleryPhotoDto.alt`).
 * - `caption` is copy shown to EVERYONE under the photo. It is genuinely
 *   optional, and it is not a substitute for `alt`: a caption saying "opening
 *   night!" tells a screen-reader user nothing about what the photo shows.
 *
 * A fourth field, `framing`, holds the focal point and zoom the owner chose for
 * how the photo sits in its frame. It is written only through the photo-framing
 * routes, so the gallery save and the legacy slot patch carry it forward by
 * image and never accept it from a request body. It is absent when the photo
 * shows centred at 1x, which is also how every photo saved before this field
 * existed reads.
 */
export interface ListingGalleryPhoto {
  image: string;
  alt: string;
  caption: string;
  framing?: ListingPhotoFraming;
}

/**
 * Where a photo is centred inside its frame and how far it is zoomed in.
 *
 * `focusX` and `focusY` are fractions of the photo's width and height, 0 being
 * the left or top edge and 1 the right or bottom edge. `zoom` is a multiplier
 * where 1 shows the whole photo. Values are stored clamped and rounded by
 * `normalizePhotoFraming`.
 */
export interface ListingPhotoFraming {
  focusX: number;
  focusY: number;
  zoom: number;
}

/**
 * The largest zoom a photo may be framed at. Past three times the photo's size
 * a typical upload shows visible pixels, so the ceiling keeps every framing
 * sharp on the detail page.
 */
export const LISTING_PHOTO_ZOOM_MAX = 3;

/**
 * How many photos one listing may carry.
 *
 * Twelve is a gallery a visitor will actually page through, and it is enough
 * room for a front, an interior, a few details, the team and a couple of
 * atmosphere shots. The old model allowed four; an unbounded list would let a
 * single listing fill the bucket and the detail page alike.
 */
export const MAX_LISTING_GALLERY_PHOTOS = 12;

/**
 * The four legacy `photos`/`alt` slot names, in the order the wizard presented
 * them. This order IS the migration's ordering rule and the transition's
 * ordering rule, so it is declared once here and read by both.
 */
export const LEGACY_PHOTO_SLOTS = ['wide', 'd1', 'd2', 'vibe'] as const;

/** Shape a submitted gallery entry arrives in (the DTO, structurally). */
interface GalleryPhotoInput {
  image: string;
  alt: string;
  caption?: string;
}

/**
 * Fills in every key of every gallery entry, so the jsonb column always holds
 * the full `ListingGalleryPhoto` shape the response DTOs promise rather than
 * whichever subset the client happened to send. Same job `normalizeSocial` and
 * `normalizeServices` do for their columns.
 *
 * Order is preserved exactly as sent: the owner arranged this list, and the
 * first entry is the page's lead photo and the card's fallback when no
 * `coverPhoto` is set, so re-sorting it would silently change the page's lead
 * photo.
 *
 * An entry with no `image` is dropped. A gallery slot with nothing in it is not
 * a photo, and keeping it would put a hole in the middle of an ordered list and
 * an empty frame on the page. Alt text alone is not a photo either: the old
 * model could store an `alt` string for an empty slot, and the directory detail
 * page rendered those as caption-only cells.
 *
 * Framing comes only from the stored gallery, matched by image. A submitted
 * entry has no say in it: the framing routes are the single writer, so a client
 * that resends the gallery without framing cannot wipe it, and one that sends a
 * framing value cannot set it. A photo that left the gallery takes its framing
 * with it, and a photo that moved to a new position keeps its own.
 */
export function normalizeGallery(
  input?: readonly GalleryPhotoInput[],
  currentGallery: readonly ListingGalleryPhoto[] = [],
): ListingGalleryPhoto[] {
  const storedFramingByImage = framingByImage(currentGallery);
  return (input ?? [])
    .filter((photo) => Boolean(photo?.image))
    .slice(0, MAX_LISTING_GALLERY_PHOTOS)
    .map((photo) => {
      const storedFraming = storedFramingByImage.get(photo.image);
      return {
        image: photo.image,
        alt: photo.alt ?? '',
        caption: photo.caption ?? '',
        ...(storedFraming ? { framing: storedFraming } : {}),
      };
    });
}

/**
 * The framing each image carries in a gallery, keyed by image reference.
 *
 * When a gallery holds the same image twice, the first occurrence wins, so the
 * lookup is deterministic and matches the entry a reader meets first.
 */
function framingByImage(
  gallery: readonly ListingGalleryPhoto[],
): Map<string, ListingPhotoFraming> {
  const framingLookup = new Map<string, ListingPhotoFraming>();
  for (const photo of gallery) {
    if (photo?.image && photo.framing && !framingLookup.has(photo.image)) {
      framingLookup.set(photo.image, photo.framing);
    }
  }
  return framingLookup;
}

/**
 * Reduces a submitted framing to the stored form, or `null` when the photo
 * shows centred at 1x and therefore needs no `framing` key at all.
 *
 * A component that is not a finite number takes its centre value (0.5, 0.5 and
 * 1), so a malformed value frames the photo neutrally. Focus is clamped to 0..1
 * and zoom to 1..`LISTING_PHOTO_ZOOM_MAX`, then every value is rounded to four
 * decimals so near-identical drags do not write distinct rows into the history.
 * The unframed check runs after rounding, so a framing within rounding distance
 * of the centre at 1x also reads as unframed.
 */
export function normalizePhotoFraming(
  input: ListingPhotoFraming,
): ListingPhotoFraming | null {
  const focusX = roundFramingValue(clampFramingValue(input.focusX, 0.5, 0, 1));
  const focusY = roundFramingValue(clampFramingValue(input.focusY, 0.5, 0, 1));
  const zoom = roundFramingValue(
    clampFramingValue(input.zoom, 1, 1, LISTING_PHOTO_ZOOM_MAX),
  );
  if (focusX === 0.5 && focusY === 0.5 && zoom === 1) return null;
  return { focusX, focusY, zoom };
}

function clampFramingValue(
  value: number,
  centreValue: number,
  minimum: number,
  maximum: number,
): number {
  const finiteValue = Number.isFinite(value) ? value : centreValue;
  return Math.min(maximum, Math.max(minimum, finiteValue));
}

function roundFramingValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Converts the legacy four-slot pair into the ordered list, in slot order and
 * skipping empty slots, carrying each slot's alt text across.
 *
 * This is the SAME mapping the migration's backfill performs in SQL, kept here
 * so a request that still sends the old `photos`/`alt` bodies lands on exactly
 * the gallery the migration would have produced for the same values.
 */
export function galleryFromLegacySlots(
  photos?: Partial<ListingPhotoSet>,
  alt?: Partial<ListingPhotoSet>,
): ListingGalleryPhoto[] {
  const gallery: ListingGalleryPhoto[] = [];
  for (const slot of LEGACY_PHOTO_SLOTS) {
    const image = photos?.[slot] ?? '';
    if (!image) continue;
    gallery.push({ image, alt: alt?.[slot] ?? '', caption: '' });
  }
  return gallery;
}

/**
 * Projects the first four gallery entries back onto the legacy slot pair.
 *
 * Used for two things, both deliberate:
 *
 * 1. The write-side mirror. The `photos`/`alt` columns are kept during the
 *    transition and rewritten from the gallery on every save, so a rollback to
 *    the previous release finds current data rather than a frozen snapshot.
 * 2. The read-side legacy fields on the response DTOs, so a frontend that has
 *    not moved to `photoGallery` yet keeps rendering.
 *
 * Entries past the fourth, and every caption, have nowhere to go in the old
 * shape. That is the cost of the old shape, and it is why the mirror is a
 * compatibility surface rather than a second source of truth.
 */
export function legacySlotsFromGallery(
  gallery: readonly ListingGalleryPhoto[],
): {
  photos: ListingPhotoSet;
  alt: ListingPhotoSet;
} {
  const photos: ListingPhotoSet = { wide: '', d1: '', d2: '', vibe: '' };
  const alt: ListingPhotoSet = { wide: '', d1: '', d2: '', vibe: '' };
  LEGACY_PHOTO_SLOTS.forEach((slot, slotIndex) => {
    const photo = gallery[slotIndex];
    if (!photo) return;
    photos[slot] = photo.image;
    alt[slot] = photo.alt;
  });
  return { photos, alt };
}

/**
 * Applies a legacy per-slot PATCH (`{ photos: { wide: ... } }`) to an existing
 * ordered gallery, positionally, without disturbing anything the old shape
 * cannot address.
 *
 * The old `update` merged `photos`/`alt` per subfield so a caller patching one
 * slot did not blank the others. That behaviour is preserved here, but the
 * naive way to preserve it (rebuild the whole gallery from the merged slots)
 * would delete every photo past the fourth and every caption on the listing.
 * So the patch rewrites only the first four positions and re-attaches the tail
 * untouched. A caption survives as long as its photo does; a slot repointed at
 * a different image loses the caption written for the previous one, which is
 * the honest outcome. Framing follows its image wherever the slot moves it, so
 * two slots that swap images swap their framing too.
 */
export function galleryWithLegacySlotPatch(
  current: readonly ListingGalleryPhoto[],
  photosPatch?: Partial<ListingPhotoSet>,
  altPatch?: Partial<ListingPhotoSet>,
): ListingGalleryPhoto[] {
  const currentSlots = legacySlotsFromGallery(current);
  const mergedImages = { ...currentSlots.photos, ...photosPatch };
  const mergedAlts = { ...currentSlots.alt, ...altPatch };
  const storedFramingByImage = framingByImage(current);

  const leadingPhotos: ListingGalleryPhoto[] = [];
  LEGACY_PHOTO_SLOTS.forEach((slot, slotIndex) => {
    const image = mergedImages[slot] ?? '';
    if (!image) return;
    const existingPhoto = current[slotIndex];
    const storedFraming = storedFramingByImage.get(image);
    leadingPhotos.push({
      image,
      alt: mergedAlts[slot] ?? '',
      caption:
        existingPhoto && existingPhoto.image === image
          ? existingPhoto.caption
          : '',
      ...(storedFraming ? { framing: storedFraming } : {}),
    });
  });

  return [...leadingPhotos, ...current.slice(LEGACY_PHOTO_SLOTS.length)].slice(
    0,
    MAX_LISTING_GALLERY_PHOTOS,
  );
}

/** Every image reference an ordered gallery holds, empty entries dropped. */
export function galleryImageReferences(
  gallery: readonly ListingGalleryPhoto[] | null | undefined,
): string[] {
  return (gallery ?? [])
    .map((photo) => photo?.image)
    .filter((image): image is string => Boolean(image));
}

/** One photo's new framing, addressed by the image reference it applies to. */
export interface ListingPhotoFramingPatch {
  image: string;
  framing: ListingPhotoFraming;
}

/**
 * Applies a photo-framing save to an ordered gallery and reports the images the
 * gallery does not hold.
 *
 * Photos are addressed by image reference, so a save made
 * against a stale ordering still frames the photo the owner was looking at. An
 * image the gallery holds more than once frames every entry that carries it,
 * because framing belongs to the image. Each framing runs through
 * `normalizePhotoFraming`, so a patch that resets a photo to the centre at 1x
 * removes the `framing` key and a photo is never stored with an inert one. When
 * the patch names one image twice the last entry wins.
 *
 * Photos the patch leaves out are copied unchanged, with whatever framing they
 * already hold. `unmatchedImages` lists each named image the gallery lacks
 * once, in the order the body named them, so the caller can refuse the save
 * with the exact images at fault. The gallery passed in is not mutated.
 */
export function galleryWithFramingPatch(
  gallery: readonly ListingGalleryPhoto[],
  patches: readonly ListingPhotoFramingPatch[],
): { gallery: ListingGalleryPhoto[]; unmatchedImages: string[] } {
  const galleryImages = new Set(galleryImageReferences(gallery));
  const framingByPatchedImage = new Map<string, ListingPhotoFraming | null>();
  const unmatchedImages: string[] = [];
  for (const patch of patches) {
    framingByPatchedImage.set(
      patch.image,
      normalizePhotoFraming(patch.framing),
    );
    if (
      !galleryImages.has(patch.image) &&
      !unmatchedImages.includes(patch.image)
    ) {
      unmatchedImages.push(patch.image);
    }
  }

  const framedGallery = gallery.map((photo) => {
    if (!framingByPatchedImage.has(photo.image)) return { ...photo };
    const { framing: _previousFraming, ...photoWithoutFraming } = photo;
    const patchedFraming = framingByPatchedImage.get(photo.image);
    return patchedFraming
      ? { ...photoWithoutFraming, framing: patchedFraming }
      : photoWithoutFraming;
  });
  return { gallery: framedGallery, unmatchedImages };
}

/**
 * The listing's own cover photo: the image every directory card shows.
 *
 * Optional and separate from the gallery. A cover only has to fill the card's
 * 7:3 frame, so owners can use a far smaller picture than a gallery photo
 * needs. A listing without one shows its first gallery photo on the card
 * (`toCoverPhoto`), so this is never backfilled.
 */
export interface ListingCoverPhoto {
  image: string;
  alt: string;
}

/**
 * The stored shape of a submitted cover, or `null` for no cover. An empty
 * `image` is no cover at all: alt text alone describes nothing.
 */
export function normalizeCoverPhoto(
  input: { image?: string | null; alt?: string | null } | null | undefined,
): ListingCoverPhoto | null {
  if (!input?.image) return null;
  return { image: input.image, alt: (input.alt ?? '').trim() };
}

/** The cover's image reference as a list, so callers can spread it beside
 * `galleryImageReferences`. */
export function coverImageReferences(
  cover: ListingCoverPhoto | null | undefined,
): string[] {
  return cover?.image ? [cover.image] : [];
}
