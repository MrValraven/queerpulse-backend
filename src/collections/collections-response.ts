import { toImageUrl } from '../common/image-url';
import { ResolvedSavedItemDTO } from '../saved/saved-response';
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

/**
 * A collection plus its filed items, hydrated from the owner's saved rows.
 *
 * Every item carries `availability` and a nullable `href` (PRD-169): a filed
 * subject that was deleted, taken down or turned private keeps its snapshot
 * title so the owner can tell what they lost, and loses its link so nothing
 * sends them to a 404.
 */
export interface CollectionDetailDTO extends CollectionDTO {
  items: ResolvedSavedItemDTO[];
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
  items: ResolvedSavedItemDTO[],
): CollectionDetailDTO {
  return { ...toCollectionDTO(collection, items.length), items };
}
