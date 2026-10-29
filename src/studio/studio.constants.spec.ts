import {
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioPlaylistVisibility } from './entities/studio-playlist.entity';
import { StudioReleaseDisputeStatus } from './entities/studio-release-dispute.entity';
import { StudioCuratedPickShelf } from './entities/studio-curated-pick.entity';
import { StudioPersonaCreditState } from './entities/studio-persona-credit.entity';
import { StudioSceneState } from './entities/studio-scene.entity';
import { StudioArtistMilestoneKind } from './entities/studio-artist-milestone.entity';
import { STUDIO_MILESTONE_KINDS } from './studio-milestones';
import { SubprofileKind } from '../subprofiles/entities/subprofile.entity';
import {
  STUDIO_ARTIST_PERSONA_KINDS,
  STUDIO_AUDIT_ACTIONS,
  STUDIO_CLAIM_LIMITS,
  STUDIO_CONTENT_WARNING_IDS,
  STUDIO_CREDIT_ROLES,
  STUDIO_CURATION_SHELVES,
  STUDIO_DISCOVERY_LIMITS,
  STUDIO_DISPUTE_STATUSES,
  STUDIO_ERROR_CODES,
  STUDIO_FALLBACK_ARTIST_PERSONA_KIND,
  STUDIO_FORMATS,
  STUDIO_FORMAT_BY_KIND,
  STUDIO_GENRES,
  STUDIO_LANDING_JOIN_SOURCES,
  STUDIO_LANDING_PHOTO_SLOTS,
  STUDIO_LANDING_PREVIEW_STATUSES,
  STUDIO_LIMITS,
  STUDIO_MOODS,
  STUDIO_PERSONA_CREDIT_STATUSES,
  STUDIO_PLAYLIST_VISIBILITIES,
  STUDIO_PLAYLIST_ROLES,
  STUDIO_PRESS,
  STUDIO_RELEASE_STATUSES,
  STUDIO_RELEASE_TYPES,
  STUDIO_RELEASE_TYPES_BY_FORMAT,
  STUDIO_RELEASE_TYPES_BY_PERSONA_KIND,
  STUDIO_SCENE_SLUG_PATTERN,
  STUDIO_SCENE_STATUSES,
  STUDIO_SCHEDULE_MAX_LEAD_DAYS,
  STUDIO_SCHEDULE_MIN_LEAD_MINUTES,
  STUDIO_SCHEDULE_TIME_ZONE,
  STUDIO_SEARCH_TYPES,
  STUDIO_SOURCE_RELEASE_TYPES,
  STUDIO_STATS_THRESHOLD,
  STUDIO_SUPPORT_PLATFORMS,
  STUDIO_TRANSCRIPT_FORMATS,
  STUDIO_VERSION_NOTE_MAX,
  isReleaseTypeAllowedForPersonaKind,
  isSourceRequiredReleaseType,
  isStudioArtistPersonaKind,
  isStudioAudioContentType,
  isStudioCreditRole,
  isStudioFormat,
  isStudioMood,
  studioAudioMaxBytesForKind,
  studioDefaultGenreForKind,
  studioDefaultGenresForKind,
  studioError,
  studioErrorWithDetails,
  studioFormatForKind,
  studioLyricsMaxLengthFor,
  studioPersonaKindsForFormat,
} from './studio.constants';
import {
  STUDIO_SAFETY_AUDIT_ACTIONS,
  STUDIO_SAFETY_ERROR_CODES,
  studioSafetyError,
} from './studio-safety.constants';

describe('Studio vocabulary', () => {
  it('keeps the entity enums identical to the wire vocabularies', () => {
    expect(Object.values(StudioReleaseType)).toEqual([...STUDIO_RELEASE_TYPES]);
    expect(Object.values(StudioReleaseStatus)).toEqual([
      ...STUDIO_RELEASE_STATUSES,
    ]);
  });

  it('orders scheduled between draft and published', () => {
    expect(STUDIO_RELEASE_STATUSES).toEqual([
      'draft',
      'scheduled',
      'published',
      'taken_down',
    ]);
  });

  it('holds the artist tools vocabularies the v3 contract sets', () => {
    expect(STUDIO_SUPPORT_PLATFORMS).toEqual(['bandcamp', 'kofi', 'patreon']);
    expect(STUDIO_SCHEDULE_MIN_LEAD_MINUTES).toBe(15);
    expect(STUDIO_SCHEDULE_MAX_LEAD_DAYS).toBe(365);
    expect(STUDIO_SCHEDULE_TIME_ZONE).toBe('Europe/Lisbon');
    expect(STUDIO_VERSION_NOTE_MAX).toBe(280);
    expect(STUDIO_PRESS).toEqual({
      pitchMax: 140,
      bioMax: 1500,
      featuredMax: 5,
      quotesMax: 3,
      quoteMax: 300,
      sourceMax: 80,
      contactMax: 1000,
      releasesShown: 6,
    });
  });

  it('bounds the buy link, the upcoming card and the scheduled drop', () => {
    expect(STUDIO_LIMITS).toEqual(
      expect.objectContaining({
        buyUrlMaxLength: 1000,
        upcomingReleasesShown: 6,
        scheduledReleasesPerTick: 100,
      }),
    );
  });

  it('offers the thirteen genres in contract order, spoken word before other', () => {
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
      'spoken-word',
      'other',
    ]);
  });

  it('knows every Studio artist kind and no other kind', () => {
    for (const kind of ['musician', 'dj', 'podcaster', 'poet', 'burlesque']) {
      expect(isStudioArtistPersonaKind(kind)).toBe(true);
    }
    expect(isStudioArtistPersonaKind('writer')).toBe(false);
    expect(isStudioArtistPersonaKind('comedian')).toBe(false);
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

  it('offers each new kind the types of its format', () => {
    expect(isReleaseTypeAllowedForPersonaKind('podcast', 'podcaster')).toBe(
      true,
    );
    expect(
      isReleaseTypeAllowedForPersonaKind('podcast', 'podcast_producer'),
    ).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('album', 'podcaster')).toBe(
      false,
    );
    expect(isReleaseTypeAllowedForPersonaKind('ep', 'poet')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('podcast', 'poet')).toBe(false);
    expect(isReleaseTypeAllowedForPersonaKind('lip_sync', 'drag')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('edit', 'voguer')).toBe(true);
    expect(isReleaseTypeAllowedForPersonaKind('mix', 'drag')).toBe(false);
    expect(isReleaseTypeAllowedForPersonaKind('podcast', 'writer')).toBe(false);
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
        likedTracksPerPage: 100,
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

  it('holds the listening limits the contract sets', () => {
    expect(STUDIO_LIMITS).toEqual(
      expect.objectContaining({
        waveformPeakCount: 200,
        waveformPeakMax: 255,
        loudnessLufsMin: -70,
        loudnessLufsMax: 0,
        peakDbMin: -60,
        peakDbMax: 3,
        syncedLyricLinesMax: 500,
        syncedLyricTextMaxLength: 300,
        syncedLyricMaxMilliseconds: 86400000,
        chaptersMax: 100,
        chapterTitleMaxLength: 120,
        chapterArtistMaxLength: 120,
      }),
    );
  });

  it('keeps the dispute status enum identical to the wire vocabulary', () => {
    expect(Object.values(StudioReleaseDisputeStatus)).toEqual([
      ...STUDIO_DISPUTE_STATUSES,
    ]);
    expect(STUDIO_DISPUTE_STATUSES).toEqual(['open', 'upheld', 'rejected']);
  });

  it('holds the dispute and staff list limits the spec sets', () => {
    expect(STUDIO_LIMITS).toEqual(
      expect.objectContaining({
        disputeNoteMaxLength: 1000,
        disputeReplyMaxLength: 1000,
        disputesPerRelease: 3,
        staffItemsPerPage: 20,
      }),
    );
  });

  it('names the two dispute decisions in the audit trail', () => {
    expect(STUDIO_AUDIT_ACTIONS.disputeUpheld).toBe(
      'studio_release_dispute_upheld',
    );
    expect(STUDIO_AUDIT_ACTIONS.disputeRejected).toBe(
      'studio_release_dispute_rejected',
    );
  });

  it('offers the eight contract moods in contract order', () => {
    expect(STUDIO_MOODS).toEqual([
      'late-night',
      'euphoric',
      'tender',
      'melancholy',
      'defiant',
      'dreamy',
      'slow-burn',
      'calm',
    ]);
    expect(isStudioMood('slow-burn')).toBe(true);
    expect(isStudioMood('sweaty')).toBe(false);
    expect(isStudioMood('playful')).toBe(false);
    expect(isStudioMood('Slow-Burn')).toBe(false);
    expect(isStudioMood('fado')).toBe(false);
  });

  it('offers the eight contract credit roles in contract order', () => {
    expect(STUDIO_CREDIT_ROLES).toEqual([
      'featured',
      'producer',
      'co-writer',
      'mixing',
      'mastering',
      'remix',
      'cover-art',
      'other',
    ]);
    expect(isStudioCreditRole('cover-art')).toBe(true);
    expect(isStudioCreditRole('drums')).toBe(false);
  });

  it('keeps the shelf, scene and credit enums identical to the wire vocabularies', () => {
    expect(Object.values(StudioCuratedPickShelf)).toEqual([
      ...STUDIO_CURATION_SHELVES,
    ]);
    expect(STUDIO_CURATION_SHELVES).toEqual([
      'featured',
      'staff_picks',
      'new_this_week',
    ]);
    expect(Object.values(StudioSceneState)).toEqual([...STUDIO_SCENE_STATUSES]);
    expect(STUDIO_SCENE_STATUSES).toEqual(['active', 'archived']);
    expect(Object.values(StudioPersonaCreditState)).toEqual([
      ...STUDIO_PERSONA_CREDIT_STATUSES,
    ]);
    expect(STUDIO_PERSONA_CREDIT_STATUSES).toEqual([
      'pending',
      'accepted',
      'declined',
    ]);
  });

  it('accepts lowercase scene slugs with single hyphens only', () => {
    for (const slug of ['lisbon-ballroom', 'porto', 'a1-b2-c3']) {
      expect(STUDIO_SCENE_SLUG_PATTERN.test(slug)).toBe(true);
    }
    for (const slug of [
      'Lisbon',
      'lisbon--ballroom',
      '-porto',
      'porto-',
      'são',
    ]) {
      expect(STUDIO_SCENE_SLUG_PATTERN.test(slug)).toBe(false);
    }
  });

  it('holds the discovery limits the contract sets', () => {
    expect(STUDIO_DISCOVERY_LIMITS).toEqual({
      curationFeaturedMax: 1,
      curationShelfMax: 12,
      curationNoteMaxLength: 140,
      sceneNameMaxLength: 60,
      sceneCityMaxLength: 60,
      sceneBlurbMaxLength: 500,
      sceneSlugMinLength: 2,
      sceneSlugMaxLength: 60,
      sceneArtistsShown: 24,
      sceneUpcomingEvents: 6,
      artistUpcomingEvents: 4,
      sceneReleasesPerPage: 24,
      personaCreditsPerTrack: 20,
      creditHandleMaxLength: 60,
      creditInboxPerSection: 100,
      appearsOnPerPage: 24,
      relatedArtistsMax: 8,
      radioMaxItems: 300,
      adminSearchResults: 20,
      adminSearchQueryMaxLength: 80,
    });
  });

  // Studio artist kinds (QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md).
  describe('formats', () => {
    it('maps every artist kind to its format, in the spec order', () => {
      expect(STUDIO_FORMATS).toEqual([
        'music',
        'podcast',
        'spoken_word',
        'performance',
      ]);
      expect(STUDIO_FORMAT_BY_KIND).toEqual({
        musician: 'music',
        dj: 'music',
        podcaster: 'podcast',
        podcast_producer: 'podcast',
        poet: 'spoken_word',
        spoken_word: 'spoken_word',
        drag: 'performance',
        performer: 'performance',
        dancer: 'performance',
        voguer: 'performance',
        burlesque: 'performance',
      });
      expect(STUDIO_ARTIST_PERSONA_KINDS).toEqual(
        Object.keys(STUDIO_FORMAT_BY_KIND),
      );
      expect(STUDIO_FALLBACK_ARTIST_PERSONA_KIND).toBe('musician');
    });

    it('names only persona kinds that exist', () => {
      const personaKinds: readonly string[] = Object.values(SubprofileKind);
      for (const kind of STUDIO_ARTIST_PERSONA_KINDS) {
        expect(personaKinds).toContain(kind);
      }
    });

    it('builds the release types of every kind from its format', () => {
      expect(STUDIO_RELEASE_TYPES_BY_FORMAT).toEqual({
        music: ['album', 'ep', 'single'],
        podcast: ['podcast'],
        spoken_word: ['album', 'ep', 'single'],
        performance: ['edit', 'lip_sync'],
      });
      expect(STUDIO_RELEASE_TYPES_BY_PERSONA_KIND).toEqual({
        musician: ['album', 'ep', 'single'],
        dj: ['mix'],
        podcaster: ['podcast'],
        podcast_producer: ['podcast'],
        poet: ['album', 'ep', 'single'],
        spoken_word: ['album', 'ep', 'single'],
        drag: ['edit', 'lip_sync'],
        performer: ['edit', 'lip_sync'],
        dancer: ['edit', 'lip_sync'],
        voguer: ['edit', 'lip_sync'],
        burlesque: ['edit', 'lip_sync'],
      });
    });

    it('reads the format of an artist kind and none for another kind', () => {
      expect(studioFormatForKind('podcast_producer')).toBe('podcast');
      expect(studioFormatForKind('dj')).toBe('music');
      expect(studioFormatForKind('writer')).toBeNull();
      expect(isStudioFormat('spoken_word')).toBe(true);
      expect(isStudioFormat('spoken-word')).toBe(false);
    });

    it('lists the persona kinds of each format', () => {
      expect(studioPersonaKindsForFormat('podcast')).toEqual([
        'podcaster',
        'podcast_producer',
      ]);
      expect(studioPersonaKindsForFormat('music')).toEqual(['musician', 'dj']);
      expect(studioPersonaKindsForFormat('performance')).toHaveLength(5);
    });

    it('caps transcripts at 60000 for podcasts and spoken word and lyrics at 10000 otherwise', () => {
      expect(STUDIO_TRANSCRIPT_FORMATS).toEqual(['podcast', 'spoken_word']);
      expect(studioLyricsMaxLengthFor('podcast')).toBe(60000);
      expect(studioLyricsMaxLengthFor('spoken_word')).toBe(60000);
      expect(studioLyricsMaxLengthFor('music')).toBe(10000);
      expect(studioLyricsMaxLengthFor('performance')).toBe(10000);
      expect(studioLyricsMaxLengthFor(null)).toBe(10000);
    });

    it('caps podcast audio at 250 MB and every other kind at 50 MB', () => {
      expect(studioAudioMaxBytesForKind('podcaster')).toBe(262144000);
      expect(studioAudioMaxBytesForKind('podcast_producer')).toBe(262144000);
      expect(studioAudioMaxBytesForKind('dj')).toBe(52428800);
      expect(studioAudioMaxBytesForKind('poet')).toBe(52428800);
      expect(studioAudioMaxBytesForKind(null)).toBe(52428800);
    });

    it('presets the spoken word genre for poets and spoken word artists only', () => {
      expect(studioDefaultGenreForKind('poet')).toBe('spoken-word');
      expect(studioDefaultGenreForKind('spoken_word')).toBe('spoken-word');
      expect(studioDefaultGenreForKind('podcaster')).toBeNull();
      expect(studioDefaultGenreForKind('musician')).toBeNull();
    });

    it('presets the spoken word genre list for poets and spoken word artists only', () => {
      expect(studioDefaultGenresForKind('poet')).toEqual(['spoken-word']);
      expect(studioDefaultGenresForKind('spoken_word')).toEqual([
        'spoken-word',
      ]);
      expect(studioDefaultGenresForKind('podcaster')).toEqual([]);
      expect(studioDefaultGenresForKind('musician')).toEqual([]);
    });

    it('lets a release carry up to five genres', () => {
      expect(STUDIO_LIMITS.releaseGenresMax).toBe(5);
    });

    it('asks edits, lip-sync mixes and mixes for sources', () => {
      expect(STUDIO_SOURCE_RELEASE_TYPES).toEqual(['mix', 'edit', 'lip_sync']);
      expect(isSourceRequiredReleaseType('lip_sync')).toBe(true);
      expect(isSourceRequiredReleaseType('mix')).toBe(true);
      expect(isSourceRequiredReleaseType('podcast')).toBe(false);
      expect(isSourceRequiredReleaseType('album')).toBe(false);
    });

    it('holds the artist kinds limits', () => {
      expect(STUDIO_LIMITS).toEqual(
        expect.objectContaining({
          lyricsMaxLength: 10000,
          lyricsMaxLengthLong: 60000,
          notesMaxLength: 4000,
          notesExcerptMaxLength: 200,
          sourcesMaxRows: 100,
          sourceFieldMaxLength: 120,
          audioMaxBytes: 52428800,
          audioMaxBytesPodcast: 262144000,
          audioParseTimeoutLongMilliseconds: 180000,
          episodesPerPage: 12,
          episodesPerPageMax: 24,
        }),
      );
    });
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
    ['studio_episode_limit', HttpStatus.CONFLICT],
    ['studio_audio_unreadable', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_audio_wrong_owner', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_playlist_limit', HttpStatus.CONFLICT],
    ['studio_playlist_track_limit', HttpStatus.CONFLICT],
    ['studio_playlist_order_mismatch', HttpStatus.CONFLICT],
    ['studio_playlist_credit_not_allowed', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_playlist_track_unavailable', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_release_withdrawn', HttpStatus.GONE],
    ['studio_release_not_taken_down', HttpStatus.CONFLICT],
    ['studio_dispute_already_open', HttpStatus.CONFLICT],
    ['studio_dispute_limit_reached', HttpStatus.CONFLICT],
    ['studio_dispute_not_open', HttpStatus.CONFLICT],
    ['studio_release_has_open_dispute', HttpStatus.CONFLICT],
    ['studio_takedown_report_mismatch', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_takedown_report_not_open', HttpStatus.CONFLICT],
    ['studio_radio_filter_required', HttpStatus.BAD_REQUEST],
    ['studio_scene_not_found', HttpStatus.NOT_FOUND],
    ['studio_credit_candidate_not_found', HttpStatus.NOT_FOUND],
    ['studio_credit_not_found', HttpStatus.NOT_FOUND],
    ['studio_curation_shelf_full', HttpStatus.CONFLICT],
    ['studio_curation_already_on_shelf', HttpStatus.CONFLICT],
    ['studio_curation_order_mismatch', HttpStatus.CONFLICT],
    ['studio_scene_slug_taken', HttpStatus.CONFLICT],
    ['studio_scene_order_mismatch', HttpStatus.CONFLICT],
    ['studio_credit_already_requested', HttpStatus.CONFLICT],
    ['studio_credit_limit', HttpStatus.CONFLICT],
    ['studio_credit_not_pending', HttpStatus.CONFLICT],
    ['studio_credit_not_accepted', HttpStatus.CONFLICT],
    ['studio_scene_not_available', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_curation_release_not_published', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_scene_event_not_pinnable', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_credit_persona_not_creditable', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_credit_self_persona', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_release_not_schedulable', HttpStatus.CONFLICT],
    ['studio_release_needs_playable_track', HttpStatus.CONFLICT],
    ['studio_release_no_changes', HttpStatus.CONFLICT],
    ['studio_preview_not_available', HttpStatus.CONFLICT],
    ['studio_schedule_out_of_range', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_press_track_not_allowed', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_preview_not_found', HttpStatus.NOT_FOUND],
    ['studio_chapters_out_of_range', HttpStatus.UNPROCESSABLE_ENTITY],
    ['studio_publish_missing_sources', HttpStatus.CONFLICT],
    ['studio_episode_show_not_published', HttpStatus.CONFLICT],
    ['studio_episode_already_published', HttpStatus.CONFLICT],
    ['studio_episode_order_locked', HttpStatus.CONFLICT],
    ['studio_not_a_podcast', HttpStatus.CONFLICT],
    ['studio_playlist_not_found', HttpStatus.NOT_FOUND],
    ['studio_playlist_entry_not_found', HttpStatus.NOT_FOUND],
    ['studio_playlist_invite_not_found', HttpStatus.NOT_FOUND],
    ['studio_playlist_editor_not_found', HttpStatus.NOT_FOUND],
    ['studio_playlist_owner_only', HttpStatus.FORBIDDEN],
    ['studio_playlist_editor_source_mismatch', HttpStatus.CONFLICT],
    ['studio_playlist_editor_cap', HttpStatus.CONFLICT],
    ['studio_playlist_invite_unavailable', HttpStatus.CONFLICT],
    ['studio_playlist_credit_change_removes_editors', HttpStatus.CONFLICT],
    ['studio_playlist_editor_ineligible', HttpStatus.UNPROCESSABLE_ENTITY],
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
    expect(new Set(STUDIO_ERROR_CODES).size).toBe(145);
  });

  it('says nothing about the release in the withdrawn body', () => {
    expect(studioError('studio_release_withdrawn').getResponse()).toEqual({
      statusCode: HttpStatus.GONE,
      code: 'studio_release_withdrawn',
      message: 'This release was withdrawn.',
    });
  });

  it('answers a 404 code as a NotFoundException and a 403 code as a ForbiddenException', () => {
    expect(studioError('studio_playlist_not_found')).toBeInstanceOf(
      NotFoundException,
    );
    expect(studioError('studio_playlist_owner_only')).toBeInstanceOf(
      ForbiddenException,
    );
    expect(studioError('studio_playlist_not_found').getResponse()).toEqual({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'studio_playlist_not_found',
      message: 'This playlist is not available.',
    });
  });

  it('adds the details to the body of a refusal that names members', () => {
    const exception = studioErrorWithDetails(
      'studio_playlist_editor_ineligible',
      { memberSlugs: ['ana-silva'] },
    );
    expect(exception.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(exception.getResponse()).toEqual({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'studio_playlist_editor_ineligible',
      message: expect.any(String) as string,
      memberSlugs: ['ana-silva'],
    });
  });

  // Studio safety and moderation.
  it('folds the safety refusals and audit actions into the Studio maps', () => {
    for (const code of STUDIO_SAFETY_ERROR_CODES) {
      expect(STUDIO_ERROR_CODES).toContain(code);
      expect(studioError(code).getResponse()).toEqual(
        studioSafetyError(code).getResponse(),
      );
    }
    expect(STUDIO_AUDIT_ACTIONS).toEqual(
      expect.objectContaining(STUDIO_SAFETY_AUDIT_ACTIONS),
    );
  });

  it('names the safety vocabulary where the contract puts it', () => {
    expect(STUDIO_CONTENT_WARNING_IDS).toHaveLength(8);
    expect(STUDIO_CLAIM_LIMITS.liveClaimsPerClaimant).toBe(10);
  });

  it('keeps the code and the status when the details carry the same keys', () => {
    const body = studioErrorWithDetails('studio_playlist_editor_cap', {
      code: 'something_else',
      statusCode: 200,
    }).getResponse();
    expect(body).toEqual(
      expect.objectContaining({
        code: 'studio_playlist_editor_cap',
        statusCode: HttpStatus.CONFLICT,
      }),
    );
  });
});

describe('Studio milestone vocabulary', () => {
  it('keeps the milestone entity enum identical to the wire vocabulary', () => {
    expect(Object.values(StudioArtistMilestoneKind)).toEqual([
      ...STUDIO_MILESTONE_KINDS,
    ]);
  });

  it('answers 404 with its code for a milestone card that is not available', () => {
    const error = studioError('studio_milestone_not_found');
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({
      statusCode: 404,
      code: 'studio_milestone_not_found',
      message: 'This milestone is not available to you.',
    });
  });
});

describe('Studio supporter errors', () => {
  it.each([
    [
      'studio_supporter_artist_not_found',
      404,
      'This artist is not available to support.',
    ],
    [
      'studio_supporter_own_persona',
      403,
      'You are a member of this artist, so you cannot be its supporter.',
    ],
    [
      'studio_supporter_identity_not_yours',
      403,
      'You can show yourself only as your account or a persona you are a member of.',
    ],
  ] as const)('answers %s with %i and its reason', (code, status, message) => {
    const error = studioError(code);
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({ statusCode: status, code, message });
  });
});

describe('Studio purchase errors', () => {
  it.each([
    ['studio_persona_not_found', 404, 'This artist page is not one you run.'],
    [
      'studio_release_type_not_for_sale',
      409,
      'Only albums, EPs and singles and their tracks can be sold.',
    ],
    [
      'studio_price_out_of_range',
      422,
      'A fixed price runs from €1 to €500, and a minimum from €0 to €500.',
    ],
    [
      'studio_payment_methods_needed_for_sale',
      409,
      'Add a way to get paid before putting music up for sale, and keep one while anything is for sale.',
    ],
    [
      'studio_payment_methods_limit',
      400,
      'An artist can list up to 8 ways to get paid.',
    ],
    [
      'studio_payment_link_invalid',
      400,
      'A payment link must be a full https:// address.',
    ],
    [
      'studio_payment_mbway_invalid',
      400,
      'MB WAY needs a Portuguese mobile number.',
    ],
    [
      'studio_payment_iban_invalid',
      400,
      'Check the IBAN: the country code, length or check digits do not match.',
    ],
    [
      'studio_purchase_item_required',
      400,
      'Choose one release or one track to buy.',
    ],
    [
      'studio_purchase_item_not_found',
      404,
      'This music is not available to you.',
    ],
    [
      'studio_purchase_own_persona',
      403,
      'You are a member of this artist, so you cannot buy its music.',
    ],
    ['studio_purchase_not_for_sale', 409, 'This is not for sale.'],
    [
      'studio_purchase_release_not_published',
      409,
      'This release is not out yet, so it cannot be bought.',
    ],
    [
      'studio_purchase_track_unavailable',
      409,
      'This track cannot be bought right now.',
    ],
    [
      'studio_purchase_unavailable',
      403,
      'You cannot buy music from this artist.',
    ],
    [
      'studio_purchase_no_payment_methods',
      409,
      'This artist has not added a way to get paid.',
    ],
    [
      'studio_purchase_pending_exists',
      409,
      'You already told this artist you paid for this; it is waiting for them.',
    ],
    [
      'studio_purchase_already_owned',
      409,
      'This is already in your collection.',
    ],
    [
      'studio_purchase_reference_invalid',
      400,
      'This payment code is too old. Get a new code, and if you already paid with the old one, put the old code in the name field so the artist can match it.',
    ],
    [
      'studio_purchase_reference_taken',
      409,
      'This payment code was just taken by another purchase. Get a new code.',
    ],
    [
      'studio_purchase_amount_below_minimum',
      422,
      "The amount is below the artist's minimum.",
    ],
    ['studio_purchase_amount_above_cap', 422, 'A purchase can be up to €500.'],
    [
      'studio_purchase_price_changed',
      409,
      'The price changed. Check the new price and try again.',
    ],
    [
      'studio_purchase_not_found',
      404,
      'This purchase is not available to you.',
    ],
    ['studio_purchase_not_pending', 409, 'This purchase was already answered.'],
    [
      'studio_purchase_wall_not_available',
      409,
      'The supporter wall is open to pending and confirmed purchases of an artist still on Studio.',
    ],
    [
      'studio_purchase_not_confirmed',
      409,
      'Downloads open once the artist confirms your payment.',
    ],
    [
      'studio_download_item_deleted',
      410,
      'The artist deleted this music, so it can no longer be downloaded.',
    ],
    [
      'studio_download_track_removed',
      410,
      'This track is no longer on the release.',
    ],
    [
      'studio_download_release_taken_down',
      410,
      'Our team took this release down, so it cannot be downloaded.',
    ],
    [
      'studio_download_artist_unavailable',
      410,
      'This artist page was removed, so its music cannot be downloaded.',
    ],
    [
      'studio_download_track_withheld',
      410,
      'A copyright claim holds this track offline, so it cannot be downloaded.',
    ],
    ['studio_download_track_not_ready', 409, 'This track has no audio yet.'],
    [
      'studio_download_track_preparing',
      409,
      'We are preparing this file for you. Try again in a few minutes.',
    ],
  ] as const)('answers %s with %i and its reason', (code, status, message) => {
    expect(studioError(code).getResponse()).toEqual({
      statusCode: status,
      code,
      message,
    });
  });

  it('keeps every purchase message free of amounts, codes and payment values', () => {
    for (const code of STUDIO_ERROR_CODES.filter((value) =>
      /studio_(?:purchase|payment|download|price|persona_not_found)/.test(
        value,
      ),
    )) {
      const { message } = studioError(code).getResponse() as {
        message: string;
      };
      expect(message).not.toMatch(/\{|\$\{|[A-Z]{2}\d{2}[A-Z0-9]{4}/);
    }
  });

  it('carries the row index of an invalid payment method in the body', () => {
    expect(
      studioErrorWithDetails('studio_payment_mbway_invalid', {
        index: 2,
      }).getResponse(),
    ).toEqual(
      expect.objectContaining({
        index: 2,
        code: 'studio_payment_mbway_invalid',
        statusCode: 400,
      }),
    );
  });
});

describe('Studio collaborative playlist vocabulary', () => {
  it('names the three roles a viewer can hold on a playlist', () => {
    expect(STUDIO_PLAYLIST_ROLES).toEqual(['owner', 'editor', 'invitee']);
  });

  it('bounds the editors, the candidate list, the slugs and the search', () => {
    expect(STUDIO_LIMITS).toEqual(
      expect.objectContaining({
        playlistEditorsMax: 10,
        playlistEditorCandidatesMax: 50,
        playlistEditorSlugMaxLength: 120,
        playlistEditorSearchMaxLength: 80,
      }),
    );
  });
});

describe('Studio landing errors', () => {
  it.each([
    [
      'studio_landing_preview_unavailable',
      404,
      'This preview is not available.',
    ],
    ['studio_landing_preview_not_found', 404, 'Preview not found.'],
    [
      'studio_landing_preview_track_not_eligible',
      422,
      'This track does not meet the rules for the Studio page.',
    ],
    [
      'studio_landing_preview_exists',
      409,
      'This track already has an open request or a live preview.',
    ],
    [
      'studio_landing_previews_full',
      409,
      'The Studio page holds up to 10 open previews.',
    ],
    [
      'studio_landing_preview_no_reachable_owner',
      409,
      'Nobody who runs this artist has Studio access, so nobody can approve the preview.',
    ],
    [
      'studio_landing_preview_not_pending',
      409,
      'This request was already answered.',
    ],
    [
      'studio_landing_preview_not_approved',
      409,
      'This preview is no longer live.',
    ],
    [
      'studio_landing_preview_main_persona_only',
      403,
      'Only the artist who released this track can approve or decline the request.',
    ],
    [
      'studio_landing_consent_required',
      400,
      'Saving needs the consent tick: confirm the people shown agreed.',
    ],
    [
      'studio_landing_persona_not_eligible',
      422,
      'This artist cannot appear on the Studio page: their page must be published and public.',
    ],
    ['studio_landing_card_exists', 409, 'This artist already has a card.'],
    [
      'studio_landing_cards_full',
      409,
      'The Studio page holds up to 6 artist cards.',
    ],
    ['studio_landing_card_not_found', 404, 'Artist card not found.'],
    [
      'studio_landing_photo_not_yours',
      403,
      'Use a photo you uploaded, or keep the one this slot holds.',
    ],
    [
      'studio_landing_order_mismatch',
      409,
      'The list changed while you reordered it. Reload and try again.',
    ],
    [
      'studio_founding_persona_not_eligible',
      422,
      'This artist cannot be a founding artist: their page must be published and public.',
    ],
    [
      'studio_founding_artist_exists',
      409,
      'This artist is already a founding artist.',
    ],
    [
      'studio_founding_artists_full',
      409,
      'The founding list holds up to 50 artists.',
    ],
    ['studio_founding_artist_not_found', 404, 'Founding artist not found.'],
    [
      'studio_access_request_exists',
      409,
      'You already asked for Studio access.',
    ],
    ['studio_access_already_granted', 409, 'You already have Studio access.'],
    [
      'studio_access_request_not_found',
      404,
      'This request is no longer waiting.',
    ],
  ] as const)('answers %s with %i and its reason', (code, status, message) => {
    const error = studioError(code);
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({ statusCode: status, code, message });
  });
});

describe('Studio landing vocabulary', () => {
  it('names the four preview states and the two photo slots', () => {
    expect(STUDIO_LANDING_PREVIEW_STATUSES).toEqual([
      'pending',
      'approved',
      'declined',
      'withdrawn',
    ]);
    expect(STUDIO_LANDING_PHOTO_SLOTS).toEqual(['hero', 'manifesto']);
  });

  it('caps the landing at five previews, ten open requests, six cards and fifty founding artists', () => {
    expect([
      STUDIO_LIMITS.landingPreviewsShown,
      STUDIO_LIMITS.landingOpenPreviewsMax,
      STUDIO_LIMITS.landingArtistCardsMax,
      STUDIO_LIMITS.foundingArtistsMax,
      STUDIO_LIMITS.accessRequestsPageSize,
    ]).toEqual([5, 10, 6, 50, 30]);
  });

  it('bounds the decided list, the quote, the photo alt and the photo credit', () => {
    expect(STUDIO_LIMITS).toEqual(
      expect.objectContaining({
        landingDecidedPreviewsShown: 30,
        landingQuoteMaxLength: 240,
        landingPhotoAltMaxLength: 200,
        landingPhotoCreditMaxLength: 120,
      }),
    );
  });

  it('names the two landing join sources', () => {
    expect(STUDIO_LANDING_JOIN_SOURCES).toEqual({
      listener: 'studio_landing',
      artist: 'studio_artist',
    });
  });
});
