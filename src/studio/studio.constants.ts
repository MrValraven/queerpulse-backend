import { HttpException, HttpStatus } from '@nestjs/common';

// The Studio v1 vocabularies, spelled exactly as the wire contract
// (QUEERPULSE-STUDIO-V1-CONTRACT-2026-10-08.md) and the frontend mirror spell
// them. Pure: storage, saved, reports and the studio module all import it.

export const STUDIO_ARTIST_PERSONA_KINDS = ['musician', 'dj'] as const;
export type StudioArtistPersonaKind =
  (typeof STUDIO_ARTIST_PERSONA_KINDS)[number];

export const STUDIO_RELEASE_TYPES = ['album', 'ep', 'single', 'mix'] as const;
export type StudioReleaseTypeValue = (typeof STUDIO_RELEASE_TYPES)[number];

export const STUDIO_RELEASE_STATUSES = [
  'draft',
  'published',
  'taken_down',
] as const;

export const STUDIO_AUDIO_CONTENT_TYPES = ['audio/mpeg', 'audio/mp4'] as const;
export type StudioAudioContentType =
  (typeof STUDIO_AUDIO_CONTENT_TYPES)[number];

export const STUDIO_SEARCH_TYPES = [
  'all',
  'releases',
  'tracks',
  'artists',
  'playlists',
] as const;
export type StudioSearchType = (typeof STUDIO_SEARCH_TYPES)[number];

// Studio v2 (QUEERPULSE-STUDIO-V2-CONTRACT-2026-10-13.md): who can open a
// playlist. Chosen at creation and changeable later.
export const STUDIO_PLAYLIST_VISIBILITIES = [
  'public',
  'connections',
  'private',
] as const;
export type StudioPlaylistVisibilityValue =
  (typeof STUDIO_PLAYLIST_VISIBILITIES)[number];

/** Stats counts from 1 to `STUDIO_STATS_THRESHOLD - 1` are withheld. */
export const STUDIO_STATS_THRESHOLD = 5;

export const STUDIO_GENRES = [
  'fado',
  'electronic',
  'folk',
  'experimental',
  'pop',
  'hip-hop',
  'r-and-b',
  'rock',
  'jazz',
  'classical',
  'ambient',
  'other',
] as const;
export type StudioGenre = (typeof STUDIO_GENRES)[number];

export const STUDIO_LIMITS = {
  releaseTitleMaxLength: 120,
  releaseDescriptionMaxLength: 2000,
  trackTitleMaxLength: 120,
  lyricsMaxLength: 10000,
  creditsMaxRows: 20,
  creditFieldMaxLength: 80,
  audioMaxBytes: 52428800,
  releasesPerPage: 24,
  searchResultsPerType: 20,
  searchQueryMaxLength: 80,
  tracksPerRelease: 50,
  artistReleasesShown: 100,
  takedownReasonMaxLength: 500,
  playlistNameMaxLength: 80,
  playlistDescriptionMaxLength: 500,
  playlistsPerMember: 100,
  tracksPerPlaylist: 500,
  tracksPerPlaylistAdd: 50,
  playlistsPerPage: 24,
  playlistsOnTrackPage: 6,
  playlistCoverCount: 4,
  // The new-release fan-out mirrors `SubprofileUpdatesService`: a bound far
  // above any real audience, chunks of one multi-row insert each, and a
  // small pool so the fan-out leaves most database connections free.
  followerAlertMaxRecipients: 5000,
  followerAlertChunkSize: 500,
  followerAlertConcurrentChunks: 3,
} as const;

export const STUDIO_RELEASE_TYPES_BY_PERSONA_KIND: Readonly<
  Record<StudioArtistPersonaKind, readonly StudioReleaseTypeValue[]>
> = {
  musician: ['album', 'ep', 'single'],
  dj: ['mix'],
};

export function isStudioArtistPersonaKind(
  kind: string,
): kind is StudioArtistPersonaKind {
  return (STUDIO_ARTIST_PERSONA_KINDS as readonly string[]).includes(kind);
}

export function isStudioAudioContentType(
  value: string,
): value is StudioAudioContentType {
  return (STUDIO_AUDIO_CONTENT_TYPES as readonly string[]).includes(value);
}

/** Whether a release type is offered to a persona of this kind. */
export function isReleaseTypeAllowedForPersonaKind(
  releaseType: string,
  personaKind: string,
): boolean {
  if (!isStudioArtistPersonaKind(personaKind)) return false;
  return (
    STUDIO_RELEASE_TYPES_BY_PERSONA_KIND[personaKind] as readonly string[]
  ).includes(releaseType);
}

export type StudioPublishRequirementCode =
  | 'studio_publish_missing_title'
  | 'studio_publish_missing_cover'
  | 'studio_publish_missing_rights'
  | 'studio_publish_missing_tracks'
  | 'studio_publish_tracks_pending';

export type StudioErrorCode =
  | 'studio_access_required'
  | 'studio_not_persona_owner'
  | 'studio_persona_kind_not_allowed'
  | StudioPublishRequirementCode
  | 'studio_release_not_draft'
  | 'studio_release_type_mismatch'
  | 'studio_track_order_mismatch'
  | 'studio_track_limit'
  | 'studio_audio_unreadable'
  | 'studio_audio_wrong_owner'
  | 'studio_playlist_limit'
  | 'studio_playlist_track_limit'
  | 'studio_playlist_order_mismatch'
  | 'studio_playlist_credit_not_allowed'
  | 'studio_playlist_track_unavailable';

const STUDIO_ERRORS: Readonly<
  Record<StudioErrorCode, { status: HttpStatus; message: string }>
> = {
  studio_access_required: {
    status: HttpStatus.FORBIDDEN,
    message: 'Studio access is required.',
  },
  studio_not_persona_owner: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the owners of this persona can change its releases.',
  },
  studio_persona_kind_not_allowed: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only musician and DJ personas can upload to Studio.',
  },
  studio_publish_missing_title: {
    status: HttpStatus.CONFLICT,
    message: 'Add a title before publishing.',
  },
  studio_publish_missing_cover: {
    status: HttpStatus.CONFLICT,
    message: 'Add a cover before publishing.',
  },
  studio_publish_missing_rights: {
    status: HttpStatus.CONFLICT,
    message: 'Confirm you hold the rights before publishing.',
  },
  studio_publish_missing_tracks: {
    status: HttpStatus.CONFLICT,
    message: 'Add at least one track before publishing.',
  },
  studio_publish_tracks_pending: {
    status: HttpStatus.CONFLICT,
    message: 'Some tracks are still uploading.',
  },
  studio_release_not_draft: {
    status: HttpStatus.CONFLICT,
    message: 'This release cannot be changed in its current state.',
  },
  studio_release_type_mismatch: {
    status: HttpStatus.CONFLICT,
    message: 'This release type is offered to a different kind of persona.',
  },
  studio_track_order_mismatch: {
    status: HttpStatus.CONFLICT,
    message: 'The new order must list every track of the release once.',
  },
  studio_track_limit: {
    status: HttpStatus.CONFLICT,
    message: 'A release holds at most 50 tracks.',
  },
  studio_audio_unreadable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This file could not be read as MP3 or M4A audio.',
  },
  studio_audio_wrong_owner: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This upload belongs to a different persona or track.',
  },
  studio_playlist_limit: {
    status: HttpStatus.CONFLICT,
    message: 'You can keep up to 100 playlists.',
  },
  studio_playlist_track_limit: {
    status: HttpStatus.CONFLICT,
    message: 'A playlist holds up to 500 tracks.',
  },
  studio_playlist_order_mismatch: {
    status: HttpStatus.CONFLICT,
    message: 'The new order must list every entry of the playlist once.',
  },
  studio_playlist_credit_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Show this playlist as yourself or as a musician or DJ persona you run that is live in Studio.',
  },
  studio_playlist_track_unavailable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'One of these tracks cannot be played right now.',
  },
};

export const STUDIO_ERROR_CODES = Object.keys(
  STUDIO_ERRORS,
) as StudioErrorCode[];

/** The one way Studio refuses a request: `{ statusCode, code, message }`. */
export function studioError(code: StudioErrorCode): HttpException {
  const { status, message } = STUDIO_ERRORS[code];
  return new HttpException({ statusCode: status, code, message }, status);
}

/** `mod_audit_logs.action` values the Studio staff routes write. */
export const STUDIO_AUDIT_ACTIONS = {
  accessGranted: 'studio_access_granted',
  accessRevoked: 'studio_access_revoked',
  releaseTakenDown: 'studio_release_taken_down',
  releaseRestored: 'studio_release_restored',
} as const;
