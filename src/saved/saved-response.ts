import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { toSavedId } from './saved-ref.util';
import { SAVED_KINDS_WITH_COVER } from './saved-studio-covers';

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
 * Studio open demo pages: why an unavailable item is unavailable, sent for
 * one cause only. `withdrawn` means staff took the Studio release behind a
 * saved release or track down, and the viewer could otherwise hear it, so
 * the reason names nothing about the viewer and discloses no block. Every
 * other cause stays the one honest "unavailable" above.
 */
export type SavedUnavailableReason = 'withdrawn';

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
  /**
   * Present only on an unavailable Studio release or track that staff took
   * down (see `SavedUnavailableReason`). Such a row keeps its `href`: the
   * release page renders a withdrawn view in place.
   */
  unavailableReason?: SavedUnavailableReason;
  /**
   * Studio Library cards: present on every `studio_release` and
   * `studio_playlist` row of the member's own list, the release cover or the
   * playlist's first playable cover. `null` when it has none, and always
   * `null` on an unavailable row, so a lost card shows no artwork.
   */
  coverUrl?: string | null;
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
  isWithdrawn = false,
): ResolvedSavedItemDTO {
  const dto: ResolvedSavedItemDTO = {
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
  if (!isAvailable && isWithdrawn) {
    return { ...dto, href: row.href ?? null, unavailableReason: 'withdrawn' };
  }
  return dto;
}

/** Maps a whole page against the set of composite refs that resolved and,
 *  for the member's own library, the set `withdrawnRefs` found and the
 *  Studio covers `savedStudioCoverUrls` found. */
export function toResolvedSavedItemDTOs(
  rows: readonly SavedItem[],
  availableRefs: ReadonlySet<string>,
  withdrawnRefs: ReadonlySet<string> = new Set(),
  coverUrlBySavedId?: ReadonlyMap<string, string>,
): ResolvedSavedItemDTO[] {
  return rows.map((row) => {
    const savedId = toSavedId(row.subjectType, row.subjectId);
    const isAvailable = availableRefs.has(savedId);
    const dto = toResolvedSavedItemDTO(
      row,
      isAvailable,
      withdrawnRefs.has(savedId),
    );
    if (!coverUrlBySavedId || !SAVED_KINDS_WITH_COVER.has(row.subjectType)) {
      return dto;
    }
    return {
      ...dto,
      coverUrl: isAvailable ? (coverUrlBySavedId.get(savedId) ?? null) : null,
    };
  });
}

/**
 * The shared-list variant of {@link toResolvedSavedItemDTO} (ENG-443).
 *
 * The snapshot-stays rule above is written for the OWNER: they saved the
 * item, so an unavailable row's title and meta are what let them recognise
 * something they lost. `SavedListsService.getShared` hands that same
 * snapshot to a RECIPIENT who saved nothing, and when the subject is
 * unavailable because its owner blocked the recipient or hid from them
 * specifically, the snapshot can be that person's name and neighbourhood (a
 * flatmate listing, say). Carrying it across the unavailable boundary tells
 * the recipient exactly who is hiding from them, which is the one thing an
 * unavailable-item card must never say. This is the only formatter that
 * blanks the snapshot, and `getShared` is its only caller.
 */
export function toSharedSavedItemDTO(
  row: SavedItem,
  isAvailable: boolean,
): ResolvedSavedItemDTO {
  if (!isAvailable) {
    return {
      id: toSavedId(row.subjectType, row.subjectId),
      kind: row.subjectType,
      title: '',
      href: null,
      meta: undefined,
      description: undefined,
      readTime: undefined,
      savedAt: row.createdAt.toISOString(),
      availability: 'unavailable',
    };
  }
  return toResolvedSavedItemDTO(row, isAvailable);
}

/** Maps a whole shared-list page through {@link toSharedSavedItemDTO}. */
export function toSharedSavedItemDTOs(
  rows: readonly SavedItem[],
  availableRefs: ReadonlySet<string>,
): ResolvedSavedItemDTO[] {
  return rows.map((row) =>
    toSharedSavedItemDTO(
      row,
      availableRefs.has(toSavedId(row.subjectType, row.subjectId)),
    ),
  );
}
