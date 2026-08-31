import { toImageUrl } from '../common/image-url';
import { SavedItemDTO } from '../saved/saved-response';
import { Collection } from './entities/collection.entity';

/**
 * Wire shape for a collection card (list + create/rename responses). Hand-mapped
 * — never the raw entity — so a column added later can't leak. `itemCount` is a
 * computed aggregate the list query attaches, not a stored column.
 */
export interface CollectionDTO {
  id: string;
  name: string;
  emoji?: string;
  /** A URL the browser can load, never the raw column: an uploaded cover is
   *  stored as a bare storage key and `toCollectionDTO` resolves it through
   *  `toImageUrl`. Absent when there is no cover. */
  cover?: string;
  itemCount: number;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** A collection plus its filed items, hydrated from the owner's saved rows. */
export interface CollectionDetailDTO extends CollectionDTO {
  items: SavedItemDTO[];
}

export function toCollectionDTO(
  collection: Collection,
  itemCount: number,
): CollectionDTO {
  return {
    id: collection.id,
    name: collection.name,
    emoji: collection.emoji ?? undefined,
    // `cover` holds either one of our storage keys or a trusted absolute URL
    // (that is what `@IsImageReference()` on the write bodies accepts), and a
    // key is not fetchable by a browser — Railway Buckets are private, so the
    // key has to become a `/files/<key>` URL on our own route. `toImageUrl`
    // also normalises the empty string to `null`, and it is `undefined` rather
    // than `null` on the wire because the field is optional in `CollectionDTO`.
    cover: toImageUrl(collection.cover) ?? undefined,
    itemCount,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
}

export function toCollectionDetailDTO(
  collection: Collection,
  items: SavedItemDTO[],
): CollectionDetailDTO {
  return { ...toCollectionDTO(collection, items.length), items };
}
