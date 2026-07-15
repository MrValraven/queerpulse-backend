import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { toSavedId } from './saved-ref.util';

/**
 * Wire shape for a saved item — matches `SavedItemDTO` in the frontend's
 * `saved.api.ts` exactly, including the composite `id` convention.
 */
export interface SavedItemDTO {
  id: string;
  kind: SavedKind;
  title: string;
  href?: string;
  meta?: string;
  description?: string;
  readTime?: string;
  /** ISO 8601 timestamp the save happened. */
  savedAt: string;
}

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
