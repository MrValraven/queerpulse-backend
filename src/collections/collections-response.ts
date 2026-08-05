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
    cover: collection.cover ?? undefined,
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
