import type { Paginated } from '../common/pagination';
import type {
  EventOrganizerView,
  EventSummary,
} from '../events/event-response';

/** Lineup entries on one event, by answer state. */
export interface AdminMusicEventLineupCounts {
  pending: number;
  accepted: number;
  declined: number;
}

export interface AdminMusicEventListItem extends EventSummary {
  lineupCounts: AdminMusicEventLineupCounts;
  pendingInviteRequestCount: number;
}

/** Counted across the house's upcoming or underway, non-cancelled Music
 *  events, and independent of the list's `bucket`. */
export interface AdminMusicEventAttention {
  pendingInviteRequestCount: number;
  pendingLineupCount: number;
}

export interface AdminMusicEventListPage {
  items: AdminMusicEventListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  attention: AdminMusicEventAttention;
}

export interface StudioArtistPersonaRef {
  subprofileId: string;
  handle: string;
  displayName: string;
  kind: string;
}

/** A member who created at least one linked, listenable Studio artist
 *  persona, with those personas. */
export interface StudioArtistCandidate extends EventOrganizerView {
  artistPersonas: StudioArtistPersonaRef[];
}

export type StudioArtistSearchPage = Paginated<StudioArtistCandidate>;
