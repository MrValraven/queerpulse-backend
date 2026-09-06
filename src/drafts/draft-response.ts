import {
  Draft,
  DraftCategory,
  DraftKindVariant,
  DraftMeta,
  DraftStatus,
} from './entities/draft.entity';

/** Matches `DraftDTO` in the frontend's `features/members/api/drafts.api.ts`. */
export interface DraftDTO {
  id: string;
  kind: string;
  kindVariant: DraftKindVariant;
  title: string;
  desc: string;
  progress: number;
  ready?: boolean;
  category?: DraftCategory;
  status?: DraftStatus;
  href?: string;
  editedMinutes?: number;
  deadlineDays?: number | null;
  sortTitle?: string;
  searchText?: string;
  /**
   * Composer state, or `null` for a draft whose surface keeps none (see
   * `DraftMeta`). Always present so a client can tell "this draft has no
   * composer state" from "this server does not send it yet".
   */
  meta: DraftMeta | null;
  /** Optimistic-concurrency counter — send it back as `expectedVersion` on the
   *  next PATCH so an interleaved save from another tab gets a 409 instead of
   *  silently discarding this one's edits. */
  version: number;
}

export function toDraftDTO(draft: Draft): DraftDTO {
  const { payload } = draft;
  return {
    id: draft.id,
    kind: draft.kind,
    kindVariant: payload.kindVariant,
    title: payload.title,
    desc: payload.desc,
    progress: payload.progress,
    ready: payload.ready,
    category: payload.category,
    status: payload.status,
    href: payload.href,
    editedMinutes: payload.editedMinutes,
    deadlineDays: payload.deadlineDays,
    sortTitle: payload.sortTitle,
    searchText: payload.searchText,
    // `?? null` because a row written before the column existed comes back
    // `null` already, and TypeORM hands `undefined` for a freshly `create`d
    // entity that never set it.
    meta: draft.meta ?? null,
    version: draft.version,
  };
}
