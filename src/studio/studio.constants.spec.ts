import { HttpStatus } from '@nestjs/common';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioPlaylistVisibility } from './entities/studio-playlist.entity';
import {
  STUDIO_ERROR_CODES,
  STUDIO_GENRES,
  STUDIO_LIMITS,
  STUDIO_PLAYLIST_VISIBILITIES,
  STUDIO_RELEASE_STATUSES,
  STUDIO_RELEASE_TYPES,
  STUDIO_SEARCH_TYPES,
  STUDIO_STATS_THRESHOLD,
  isReleaseTypeAllowedForPersonaKind,
  isStudioArtistPersonaKind,
  isStudioAudioContentType,
  studioError,
} from './studio.constants';

describe('Studio vocabulary', () => {
  it('keeps the entity enums identical to the wire vocabularies', () => {
    expect(Object.values(StudioReleaseType)).toEqual([...STUDIO_RELEASE_TYPES]);
    expect(Object.values(StudioReleaseStatus)).toEqual([
      ...STUDIO_RELEASE_STATUSES,
    ]);
  });

  it('offers the twelve contract genres in contract order', () => {
    expect(STUDIO_GENRES).toEqual([
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
    ]);
  });

  it('knows musician and DJ as the artist kinds', () => {
    expect(isStudioArtistPersonaKind('musician')).toBe(true);
    expect(isStudioArtistPersonaKind('dj')).toBe(true);
    expect(isStudioArtistPersonaKind('writer')).toBe(false);
  });

  it('offers mix to a DJ and the three record types to a musician', () => {
    expect(isReleaseTypeAllowedForPersonaKind('mix', 'dj')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('album', 'dj')).toBe(false);
    expect(isReleaseTypeAllowedForPersonaKind('album', 'musician')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('ep', 'musician')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('single', 'musician')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('mix', 'musician')).toBe(false);
    expect(isReleaseTypeAllowedForPersonaKind('single', 'writer')).toBe(false);
  });

  it('accepts MP3 and M4A audio only', () => {
    expect(isStudioAudioContentType('audio/mpeg')).toBe(true);
    expect(isStudioAudioContentType('audio/mp4')).toBe(true);
    expect(isStudioAudioContentType('audio/wav')).toBe(false);
  });

  it('caps audio at 50 MB', () => {
    expect(STUDIO_LIMITS.audioMaxBytes).toBe(52428800);
  });

  it('keeps the playlist visibility enum identical to the wire vocabulary', () => {
    expect(Object.values(StudioPlaylistVisibility)).toEqual([
      ...STUDIO_PLAYLIST_VISIBILITIES,
    ]);
    expect(STUDIO_PLAYLIST_VISIBILITIES).toEqual([
      'public',
      'connections',
      'private',
    ]);
  });

  it('offers playlists as a search type', () => {
    expect(STUDIO_SEARCH_TYPES).toEqual([
      'all',
      'releases',
      'tracks',
      'artists',
      'playlists',
    ]);
  });

  it('withholds stats counts below five', () => {
    expect(STUDIO_STATS_THRESHOLD).toBe(5);
  });

  it('holds the playlist limits the contract sets', () => {
    expect(STUDIO_LIMITS).toEqual(
      expect.objectContaining({
        playlistNameMaxLength: 80,
        playlistDescriptionMaxLength: 500,
        playlistsPerMember: 100,
        tracksPerPlaylist: 500,
        tracksPerPlaylistAdd: 50,
        playlistsPerPage: 24,
        playlistsOnTrackPage: 6,
        playlistCoverCount: 4,
      }),
    );
  });

  it('bounds the new-release fan-out like the persona update fan-out', () => {
    expect(STUDIO_LIMITS.followerAlertMaxRecipients).toBe(5000);
    expect(STUDIO_LIMITS.followerAlertChunkSize).toBe(500);
    expect(STUDIO_LIMITS.followerAlertConcurrentChunks).toBe(3);
  });
});

describe('studioError', () => {
  it.each([
    ['studio_access_required', HttpStatus.FORBIDDEN],
    ['studio_not_persona_owner', HttpStatus.FORBIDDEN],
    ['studio_persona_kind_not_allowed', HttpStatus.FORBIDDEN],
    ['studio_publish_missing_title', HttpStatus.CONFLICT],
    ['studio_publish_missing_cover', HttpStatus.CONFLICT],
    ['studio_publish_missing_rights', HttpStatus.CONFLICT],
    ['studio_publish_missing_tracks', HttpStatus.CONFLICT],
    ['studio_publish_tracks_pending', HttpStatus.CONFLICT],
    ['studio_release_not_draft', HttpStatus.CONFLICT],
    ['studio_release_type_mismatch', HttpStatus.CONFLICT],
    ['studio_track_order_mismatch', HttpStatus.CONFLICT],
    ['studio_track_limit', HttpStatus.CONFLICT],
    ['studio_audio_unreadable', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_audio_wrong_owner', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_playlist_limit', HttpStatus.CONFLICT],
    ['studio_playlist_track_limit', HttpStatus.CONFLICT],
    ['studio_playlist_order_mismatch', HttpStatus.CONFLICT],
    ['studio_playlist_credit_not_allowed', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_playlist_track_unavailable', HttpStatus.UNPROCESSABLE_ENTITY],
  ] as const)(
    'answers %s with HTTP %i and the code in the body',
    (code, status) => {
      const exception = studioError(code);
      expect(exception.getStatus()).toBe(status);
      expect(exception.getResponse()).toEqual(
        expect.objectContaining({ statusCode: status, code }),
      );
    },
  );

  it('lists every contract code exactly once', () => {
    expect(new Set(STUDIO_ERROR_CODES).size).toBe(19);
  });
});
