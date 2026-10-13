import { HttpStatus } from '@nestjs/common';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  STUDIO_ERROR_CODES,
  STUDIO_GENRES,
  STUDIO_LIMITS,
  STUDIO_RELEASE_STATUSES,
  STUDIO_RELEASE_TYPES,
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
    expect(new Set(STUDIO_ERROR_CODES).size).toBe(14);
  });
});
