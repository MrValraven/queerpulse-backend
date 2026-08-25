import type { ListingPhotoSet } from './entities/listing.entity';

/**
 * One photo in a listing's ordered gallery.
 *
 * This replaces the four fixed named slots (`wide`/`d1`/`d2`/`vibe`) the
 * `photos` and `alt` jsonb columns used to hold. Those slots could not express
 * three detail shots, five photos, a cover the owner picked, or a caption, and
 * they kept an image and its own alt text in two separate columns that could
 * drift apart. Here every photo carries its own description, and the ORDER of
 * the array is the order the owner arranged: index 0 is the cover.
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
 */
export interface ListingGalleryPhoto {
  image: string;
  alt: string;
  caption: string;
}

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
 * first entry is the cover, so re-sorting it would silently repick their cover
 * photo.
 *
 * An entry with no `image` is dropped. A gallery slot with nothing in it is not
 * a photo, and keeping it would put a hole in the middle of an ordered list and
 * an empty frame on the page. Alt text alone is not a photo either: the old
 * model could store an `alt` string for an empty slot, and the directory detail
 * page rendered those as caption-only cells.
 */
export function normalizeGallery(
  input?: readonly GalleryPhotoInput[],
): ListingGalleryPhoto[] {
  return (input ?? [])
    .filter((photo) => Boolean(photo?.image))
    .slice(0, MAX_LISTING_GALLERY_PHOTOS)
    .map((photo) => ({
      image: photo.image,
      alt: photo.alt ?? '',
      caption: photo.caption ?? '',
    }));
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
 * the honest outcome.
 */
export function galleryWithLegacySlotPatch(
  current: readonly ListingGalleryPhoto[],
  photosPatch?: Partial<ListingPhotoSet>,
  altPatch?: Partial<ListingPhotoSet>,
): ListingGalleryPhoto[] {
  const currentSlots = legacySlotsFromGallery(current);
  const mergedImages = { ...currentSlots.photos, ...photosPatch };
  const mergedAlts = { ...currentSlots.alt, ...altPatch };

  const leadingPhotos: ListingGalleryPhoto[] = [];
  LEGACY_PHOTO_SLOTS.forEach((slot, slotIndex) => {
    const image = mergedImages[slot] ?? '';
    if (!image) return;
    const existingPhoto = current[slotIndex];
    leadingPhotos.push({
      image,
      alt: mergedAlts[slot] ?? '',
      caption:
        existingPhoto && existingPhoto.image === image
          ? existingPhoto.caption
          : '',
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
