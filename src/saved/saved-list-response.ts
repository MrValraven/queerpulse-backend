import { SavedList } from './entities/saved-list.entity';
import { SavedItemDTO } from './saved-response';

/**
 * Wire shape of one of the caller's own lists. Hand-mapped from the entity like
 * every other response in this codebase (there is no global serializer), so a
 * column added later cannot leak by default.
 */
export interface SavedListDTO {
  id: string;
  name: string;
  /** The "everything I saved" list: cannot be renamed away from its role,
   *  deleted, or have items pulled out of it directly. */
  isDefault: boolean;
  itemCount: number;
  /** Whether a share link currently exists. Always false until the owner asks
   *  for one. */
  isShared: boolean;
  /**
   * The share secret itself, or `null` when the list is private. Returned ONLY
   * on the owner's own reads (`GET /me/saved/lists`, and the share/unshare
   * writes) because it IS the link they are about to send someone. It never
   * appears on the public shared read, which would be handing a recipient the
   * credential to re-share.
   */
  shareToken: string | null;
  /** ISO 8601 timestamp the current link was minted, or `null`. */
  sharedAt: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/**
 * What somebody holding a share link sees.
 *
 * Deliberately anonymous: no owner id, no slug, no name, no avatar, no
 * `createdAt` on the list. A list of queer venues is a record of where a person
 * goes; the recipient was given the places, not the person. If a member wants
 * their friend to know the list is theirs, they can say so in the message they
 * send with the link, which is a disclosure they make rather than one the API
 * makes for them.
 */
export interface SharedSavedListDTO {
  name: string;
  itemCount: number;
  items: SavedItemDTO[];
}

export function toSavedListDTO(
  list: SavedList,
  itemCount: number,
): SavedListDTO {
  return {
    id: list.id,
    name: list.name,
    isDefault: list.isDefault,
    itemCount,
    isShared: list.shareToken !== null,
    shareToken: list.shareToken,
    sharedAt: list.sharedAt ? list.sharedAt.toISOString() : null,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  };
}
