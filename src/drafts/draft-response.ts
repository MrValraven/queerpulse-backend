import {
  Draft,
  DraftCategory,
  DraftKindVariant,
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
  };
}
