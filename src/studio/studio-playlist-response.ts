import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { effectivePlaylistVisibility } from './studio-playlist-visibility';
import {
  StudioArtistPersona,
  StudioArtistRef,
  StudioArtistResponse,
  StudioReleaseCard,
  StudioSearchResult,
  StudioTrackSummary,
  toStudioArtistRef,
} from './studio-response';
import { STUDIO_LIMITS } from './studio.constants';

// Wire shapes of the Studio v2 contract for playlists. `StudioPlaylist` in
// the contract is `StudioPlaylistResponse` here, beside the entity.

export interface StudioPlaylistMemberCredit {
  id: string;
  /** The member's profile slug, for a `/members/<slug>` link. */
  slug: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Who a playlist shows as. Exactly one of the two is set. */
export interface StudioPlaylistCredit {
  persona: StudioArtistRef | null;
  member: StudioPlaylistMemberCredit | null;
}

export interface StudioPlaylistCard {
  id: string;
  name: string;
  credit: StudioPlaylistCredit;
  /** Up to four distinct release covers, in playlist order. */
  coverUrls: string[];
  /** Tracks this viewer can play. */
  trackCount: number;
  totalDurationSeconds: number;
  updatedAt: string;
  isOwner: boolean;
  /** The owner's own view only; null for everyone else. */
  visibility: StudioPlaylistVisibility | null;
}

export type StudioPlaylistEntryTrack = StudioTrackSummary & {
  release: StudioReleaseCard;
};

export interface StudioPlaylistEntryResponse {
  entryId: string;
  /** 1-based and contiguous over the entries this viewer receives. */
  position: number;
  addedAt: string;
  /** False reaches the owner only. */
  isAvailable: boolean;
  /**
   * Studio open demo pages, in the owner's view only: `withdrawn` when the
   * entry is unavailable because staff took its release down (and the
   * owner could otherwise hear it). Absent for every other cause and on
   * every available entry.
   */
  unavailableReason?: 'withdrawn';
  track: StudioPlaylistEntryTrack | null;
}

export interface StudioPlaylistResponse extends StudioPlaylistCard {
  description: string | null;
  entries: StudioPlaylistEntryResponse[];
  /** The owner's own view only. */
  creditSubprofileId: string | null;
}

export interface StudioPlaylistPlayableStats {
  trackCount: number;
  totalDurationSeconds: number;
}

export const EMPTY_PLAYLIST_STATS: StudioPlaylistPlayableStats = {
  trackCount: 0,
  totalDurationSeconds: 0,
};

/** `GET /studio/tracks/:id/playlists`. */
export interface StudioPlaylistList {
  items: StudioPlaylistCard[];
}

export type StudioSearchResultWithPlaylists = StudioSearchResult & {
  playlists: StudioPlaylistCard[];
};

export type StudioArtistWithPlaylists = StudioArtistResponse & {
  playlists: StudioPlaylistCard[];
};

/** What one card is built from. `persona` is the credited persona when the
 *  credit stands; `member` is the owner's profile reference. */
export interface StudioPlaylistCardSource {
  playlist: StudioPlaylist;
  viewerId: string;
  isCreditBroken: boolean;
  persona: StudioArtistPersona | undefined;
  member: MemberRef | undefined;
  stats: StudioPlaylistPlayableStats;
  coverKeys: string[];
}

export function memberDisplayName(member: MemberRef | undefined): string {
  const fullName = member
    ? `${member.firstName} ${member.lastName}`.trim()
    : '';
  return fullName || 'Member';
}

/** `MemberRef` comes from one batched profile read (`MemberLookup
 *  .byUserIds`), so the slug costs no extra query. `MemberRef.avatarUrl`
 *  already honours the member's photo setting. A member with no profile row
 *  gets an empty slug, which the frontend renders without a link. */
export function toStudioPlaylistMemberCredit(
  userId: string,
  member: MemberRef | undefined,
): StudioPlaylistMemberCredit {
  return {
    id: userId,
    slug: member?.slug ?? '',
    displayName: memberDisplayName(member),
    avatarUrl: member?.avatarUrl ?? null,
  };
}

/** A persona-credited playlist names its owner to the owner alone. */
export function toStudioPlaylistCredit(
  source: StudioPlaylistCardSource,
): StudioPlaylistCredit {
  const { playlist, viewerId, isCreditBroken, persona, member } = source;
  if (playlist.isCreditedToPersona && !isCreditBroken && persona) {
    return { persona: toStudioArtistRef(persona), member: null };
  }
  // Fail closed: readers filter broken credits out before mapping, so this
  // only fires on a reader bug, and a 500 beats naming the owner.
  if (playlist.isCreditedToPersona && playlist.userId !== viewerId) {
    throw new Error(
      'A persona-credited playlist reached a viewer without its persona',
    );
  }
  return {
    persona: null,
    member: toStudioPlaylistMemberCredit(playlist.userId, member),
  };
}

export function toStudioPlaylistCard(
  source: StudioPlaylistCardSource,
): StudioPlaylistCard {
  const { playlist, viewerId, isCreditBroken, stats, coverKeys } = source;
  const isOwner = playlist.userId === viewerId;
  return {
    id: playlist.id,
    name: playlist.name,
    credit: toStudioPlaylistCredit(source),
    coverUrls: coverKeys
      .slice(0, STUDIO_LIMITS.playlistCoverCount)
      .flatMap((key) => {
        const url = toImageUrl(key);
        return url ? [url] : [];
      }),
    trackCount: stats.trackCount,
    totalDurationSeconds: stats.totalDurationSeconds,
    updatedAt: playlist.updatedAt.toISOString(),
    isOwner,
    visibility: isOwner
      ? effectivePlaylistVisibility(playlist.visibility, isCreditBroken)
      : null,
  };
}

export function toStudioPlaylistResponse(
  card: StudioPlaylistCard,
  playlist: StudioPlaylist,
  entries: StudioPlaylistEntryResponse[],
  isCreditBroken: boolean,
): StudioPlaylistResponse {
  return {
    ...card,
    description: playlist.description,
    entries,
    creditSubprofileId:
      card.isOwner && !isCreditBroken ? playlist.creditSubprofileId : null,
  };
}
