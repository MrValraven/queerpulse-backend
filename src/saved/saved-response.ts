import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { toSavedId } from './saved-ref.util';

/**
 * Whether the thing a saved item points at is still there for THIS viewer
 * (PRD-169).
 *
 * `unavailable` is one state covering several causes on purpose: the subject
 * row is gone, soft-deleted or tombstoned, its module has taken it down, or the
 * viewer may no longer see it (a community turned private, a block, a share
 * link opened by somebody with no account). Splitting those apart on the wire
 * would tell a share-link recipient which of a stranger's bookmarks are
 * private-but-real, which is exactly the disclosure the subject modules 404 to
 * avoid. The member sees one honest "no longer available".
 */
export type SavedAvailability = 'available' | 'unavailable';

/**
 * The presentational SNAPSHOT of a saved item: what the member's client copied
 * off the thing at the moment they saved it, plus its composite ref.
 *
 * `href` and `availability` are optional HERE, and only here, because
 * `CollectionsService.hydrateItems` reuses this shape for filed collection
 * items and does not resolve availability. Every response the saved module
 * itself serves uses {@link ResolvedSavedItemDTO} below, where both are
 * required and always populated.
 */
export interface SavedItemDTO {
  id: string;
  kind: SavedKind;
  title: string;
  href?: string | null;
  meta?: string;
  description?: string;
  readTime?: string;
  /** ISO 8601 timestamp the save happened. */
  savedAt: string;
  availability?: SavedAvailability;
}

/**
 * What every saved-module read returns: the snapshot with the availability
 * question answered.
 *
 * Both new fields are ALWAYS present. `href` is `null` whenever the item is
 * unavailable, so a client that links it anyway still cannot send anyone to a
 * 404, and `null` too for an available item that was saved without one.
 *
 * An unavailable item KEEPS its stored `title`, `meta`, `description` and
 * `readTime`. The snapshot is what lets a member recognise what they lost;
 * blanking it would turn "the thread you saved about finding a GP is gone" into
 * an anonymous empty row.
 */
export interface ResolvedSavedItemDTO extends SavedItemDTO {
  href: string | null;
  availability: SavedAvailability;
}

/**
 * The snapshot alone, with no availability claim. Kept for
 * `CollectionsService.hydrateItems`, which reads `saved_item` rows for a
 * different surface and resolves nothing; it must not start asserting
 * `availability: 'available'` for subjects it never looked up.
 */
export function toSavedItemDTO(row: SavedItem): SavedItemDTO {
  return {
    id: toSavedId(row.subjectType, row.subjectId),
    kind: row.subjectType,
    title: row.title,
    href: row.href ?? undefined,
    meta: row.meta ?? undefined,
    description: row.description ?? undefined,
    readTime: row.readTime ?? undefined,
    savedAt: row.createdAt.toISOString(),
  };
}

/**
 * Hand-maps one row with the availability answer the caller resolved for the
 * whole page in batch (`SavedAvailabilityService.availableRefs`). Availability
 * is a parameter rather than something this function looks up, because
 * resolving it per row is the N+1 this feature exists to avoid.
 */
export function toResolvedSavedItemDTO(
  row: SavedItem,
  isAvailable: boolean,
): ResolvedSavedItemDTO {
  return {
    id: toSavedId(row.subjectType, row.subjectId),
    kind: row.subjectType,
    title: row.title,
    href: isAvailable ? (row.href ?? null) : null,
    meta: row.meta ?? undefined,
    description: row.description ?? undefined,
    readTime: row.readTime ?? undefined,
    savedAt: row.createdAt.toISOString(),
    availability: isAvailable ? 'available' : 'unavailable',
  };
}

/** Maps a whole page against the set of composite refs that resolved. */
export function toResolvedSavedItemDTOs(
  rows: readonly SavedItem[],
  availableRefs: ReadonlySet<string>,
): ResolvedSavedItemDTO[] {
  return rows.map((row) =>
    toResolvedSavedItemDTO(
      row,
      availableRefs.has(toSavedId(row.subjectType, row.subjectId)),
    ),
  );
}
