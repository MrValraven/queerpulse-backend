import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioReleaseCard } from './studio-response';
import { StudioCurationShelf } from './studio.constants';

/** A release card with its status, for the staff views. */
export type AdminStudioReleaseCard = StudioReleaseCard & {
  status: StudioReleaseStatus;
};

export interface AdminStudioPick {
  id: string;
  shelf: StudioCurationShelf;
  /** 1-based, contiguous per shelf. */
  position: number;
  note: string | null;
  /** The admin page shows the pick's age from it. */
  createdAt: string;
  /** Published and the persona listenable; blocks are ignored for staff. */
  isListenable: boolean;
  release: AdminStudioReleaseCard;
}

/** Every row, listenable or not. `featured` holds 0 or 1 pick. */
export interface AdminStudioCuration {
  featured: AdminStudioPick[];
  staffPicks: AdminStudioPick[];
  newThisWeek: AdminStudioPick[];
}

export interface AdminPickRow {
  id: string;
  shelf: StudioCurationShelf;
  position: number;
  note: string | null;
  created_at: Date;
  release_id: string;
  release_status: StudioReleaseStatus;
  is_listenable: boolean;
}

export function toAdminStudioReleaseCard(
  card: StudioReleaseCard,
  status: StudioReleaseStatus,
): AdminStudioReleaseCard {
  return { ...card, status };
}

export function toAdminStudioPick(
  row: AdminPickRow,
  card: StudioReleaseCard,
): AdminStudioPick {
  return {
    id: row.id,
    shelf: row.shelf,
    position: row.position,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    isListenable: row.is_listenable,
    release: toAdminStudioReleaseCard(card, row.release_status),
  };
}

export function groupAdminPicks(picks: AdminStudioPick[]): AdminStudioCuration {
  return {
    featured: picks.filter((pick) => pick.shelf === 'featured'),
    staffPicks: picks.filter((pick) => pick.shelf === 'staff_picks'),
    newThisWeek: picks.filter((pick) => pick.shelf === 'new_this_week'),
  };
}
