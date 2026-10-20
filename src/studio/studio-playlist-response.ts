import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { StudioPlaylistEditor } from './entities/studio-playlist-editor.entity';
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
import { STUDIO_LIMITS, StudioPlaylistRole } from './studio.constants';

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

/** Collaborative playlists: a member as the owner and editors see them. No
 *  user id on the wire; `slug` is empty for a member with no profile row. */
export interface StudioPlaylistPerson {
  slug: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface StudioPlaylistEditorResponse {
  /** `studio_playlist_editors.id`: the owner removes a row by it. */
  editorId: string;
  member: StudioPlaylistPerson;
  /** Ended rows never leave the server. */
  status: 'invited' | 'active';
  source: 'member_invite' | 'persona_co_owner';
  invitedAt: string;
}

export interface StudioPlaylistEditorList {
  items: StudioPlaylistEditorResponse[];
}

export interface StudioPlaylistEditorCandidate {
  member: StudioPlaylistPerson;
  isEditor: boolean;
}

export interface StudioPlaylistEditorCandidateList {
  items: StudioPlaylistEditorCandidate[];
}

export interface StudioPlaylistInvite {
  invitedBy: StudioPlaylistPerson;
  invitedAt: string;
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
  /** The viewer's role on this playlist; null for everyone else.
   *  `isOwner` stays and equals `role === 'owner'`. */
  role: StudioPlaylistRole | null;
  /** Active editors, for the owner and editors; null for everyone else. */
  editorCount: number | null;
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
  /** Who added the entry, for the owner and active editors only, and only
   *  when it is the owner or a current active editor. */
  addedBy: StudioPlaylistPerson | null;
}

export interface StudioPlaylistResponse extends StudioPlaylistCard {
  description: string | null;
  entries: StudioPlaylistEntryResponse[];
  /** The owner's own view only. */
  creditSubprofileId: string | null;
  /** The open invitation, for an invitee only. */
  invite: StudioPlaylistInvite | null;
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
  /** The viewer's live editor row on this playlist, read with the block
   *  guard; absent or null for no row. */
  editorRole?: 'editor' | 'invitee' | null;
  /** Active editors of the playlist; read only for owner and editor. */
  activeEditorCount?: number;
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

/** `MemberRef` comes from one batched profile read and already honours the
 *  photo setting. */
export function toStudioPlaylistPerson(
  member: MemberRef | undefined,
): StudioPlaylistPerson {
  return {
    slug: member?.slug ?? '',
    displayName: memberDisplayName(member),
    avatarUrl: member?.avatarUrl ?? null,
  };
}

/** A live editor row on the wire. Callers pass `invited` or `active` rows
 *  only. */
export function toStudioPlaylistEditorResponse(
  row: Pick<StudioPlaylistEditor, 'id' | 'status' | 'source' | 'invitedAt'>,
  member: StudioPlaylistPerson,
): StudioPlaylistEditorResponse {
  return {
    editorId: row.id,
    member,
    status: row.status as StudioPlaylistEditorResponse['status'],
    source: row.source,
    invitedAt: row.invitedAt.toISOString(),
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
  const role: StudioPlaylistRole | null = isOwner
    ? 'owner'
    : (source.editorRole ?? null);
  const canSeeEditors = role === 'owner' || role === 'editor';
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
    role,
    editorCount: canSeeEditors ? (source.activeEditorCount ?? 0) : null,
  };
}

export function toStudioPlaylistResponse(
  card: StudioPlaylistCard,
  playlist: StudioPlaylist,
  entries: StudioPlaylistEntryResponse[],
  isCreditBroken: boolean,
  invite: StudioPlaylistInvite | null = null,
): StudioPlaylistResponse {
  return {
    ...card,
    description: playlist.description,
    entries,
    creditSubprofileId:
      card.isOwner && !isCreditBroken ? playlist.creditSubprofileId : null,
    invite: card.role === 'invitee' ? invite : null,
  };
}
