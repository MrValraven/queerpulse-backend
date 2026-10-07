import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import { normalizeOnlineListingUrl } from './listing-online-details';
import type { ListingGalleryPhoto } from './listing-photo-gallery';
import type { ListingGalleryPhotoView } from './listing-response';

/**
 * "In the shop": up to six things a listing sells online, shown when its
 * `pricingMode` is `shop`. Stored as one jsonb column (`listings.shop_items`)
 * and normalised on read and write like `onlineDetails`.
 *
 * `price` is free text for the reason a service's price is ("from 12 EUR",
 * "pay what you can"). The photo is an ordinary listing photo upload with the
 * gallery's own shape and validation. Its storage key is a registered media
 * reference (`Listing.shopItems[].photo.image`), so storage maintenance keeps
 * it, and the listing's orphan cleanup and foreign-upload check read it
 * beside the gallery.
 */
export const MAX_LISTING_SHOP_ITEMS = 6;
export const MAX_SHOP_ITEM_ID_LENGTH = 60;
export const MAX_SHOP_ITEM_NAME_LENGTH = 60;
export const MAX_SHOP_ITEM_PRICE_LENGTH = 20;

export interface ListingShopItem {
  /** Client-generated (a uuid in practice) and kept stable across edits. */
  id: string;
  name: string;
  price: string;
  /** `''` when the item has no link of its own. */
  link: string;
  photo: ListingGalleryPhoto | null;
}

/** A shop item as every response carries it: the photo resolved the way the gallery's photos are. */
export interface ListingShopItemView extends Omit<ListingShopItem, 'photo'> {
  photo: ListingGalleryPhotoView | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, maxLength).join('');
}

function normalizeShopItemPhoto(raw: unknown): ListingGalleryPhoto | null {
  const source = asRecord(raw);
  if (source === null) return null;
  const image = source.image;
  if (typeof image !== 'string' || image === '') return null;
  return {
    image,
    alt: typeof source.alt === 'string' ? source.alt : '',
    caption: typeof source.caption === 'string' ? source.caption : '',
  };
}

/**
 * Any stored or submitted list, read as at most six complete items: trimmed,
 * the link stored with `https://` (or `''` when it is no web address), the
 * photo filled to the gallery shape. An item with no id or no name, and a
 * repeated id, drop out. Idempotent, so it runs on reads and writes alike.
 */
export function normalizeListingShopItems(raw: unknown): ListingShopItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ListingShopItem[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw as unknown[]) {
    const source = asRecord(entry);
    if (source === null) continue;
    const id = trimmedText(source.id, MAX_SHOP_ITEM_ID_LENGTH);
    const name = trimmedText(source.name, MAX_SHOP_ITEM_NAME_LENGTH);
    if (id === '' || name === '' || seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({
      id,
      name,
      price: trimmedText(source.price, MAX_SHOP_ITEM_PRICE_LENGTH),
      link: normalizeOnlineListingUrl(source.link) ?? '',
      photo: normalizeShopItemPhoto(source.photo),
    });
    if (items.length === MAX_LISTING_SHOP_ITEMS) break;
  }
  return items;
}

/** Every image reference the shop items hold, for crops, orphan cleanup and the foreign-upload check. */
export function shopItemImageReferences(raw: unknown): string[] {
  return normalizeListingShopItems(raw).flatMap((item) =>
    item.photo ? [item.photo.image] : [],
  );
}

/**
 * The response shape. `crops` is the caller's one batched
 * `MediaCropService.getMany` result (see `listingPhotoKeys`), so this stays
 * synchronous.
 */
export function toListingShopItemViews(
  raw: unknown,
  crops: Map<string, CropRect> = new Map(),
): ListingShopItemView[] {
  return normalizeListingShopItems(raw).map((item) => {
    if (item.photo === null) return { ...item, photo: null };
    const crop = cropFor(item.photo.image, crops);
    return {
      ...item,
      photo: {
        image: toImageUrl(item.photo.image),
        alt: item.photo.alt,
        caption: item.photo.caption,
        ...(crop ? { crop } : {}),
      },
    };
  });
}
