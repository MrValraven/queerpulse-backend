import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  STUDIO_SAFETY_AUDIT_ACTIONS,
  STUDIO_SAFETY_ERRORS,
  StudioSafetyErrorCode,
} from './studio-safety.constants';

// Studio safety and moderation: the vocabulary lives in
// `studio-safety.constants.ts`; the contract names it here too.
export {
  STUDIO_CLAIMANT_ROLES,
  STUDIO_CLAIM_HOLDING_STATUSES,
  STUDIO_CLAIM_LIMITS,
  STUDIO_CLAIM_LIVE_STATUSES,
  STUDIO_CLAIM_OWNER_VISIBLE_STATUSES,
  STUDIO_CLAIM_STATUSES,
  STUDIO_CONTENT_WARNINGS_MAX,
  STUDIO_CONTENT_WARNING_IDS,
} from './studio-safety.constants';
export type { StudioContentWarningId } from './studio-safety.constants';

// The Studio v1 vocabularies, spelled exactly as the wire contract
// (QUEERPULSE-STUDIO-V1-CONTRACT-2026-10-08.md) and the frontend mirror spell
// them. Pure: storage, saved, reports and the studio module all import it.

// Studio artist kinds (QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md).
export const STUDIO_FORMATS = [
  'music',
  'podcast',
  'spoken_word',
  'performance',
] as const;
export type StudioFormat = (typeof STUDIO_FORMATS)[number];

/**
 * The one map from persona kind to Studio format. Its keys, in this order,
 * are the persona kinds that publish in Studio; every artist kind check in
 * the backend reads it through the names below. Mirrored in the frontend
 * `studio.types.ts`, and `queerpulse/scripts/check-work-taxonomy.mjs` parses
 * this literal to compare the two, so keep one `kind: 'format',` entry per
 * line.
 */
export const STUDIO_FORMAT_BY_KIND = {
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
} as const satisfies Record<string, StudioFormat>;

export type StudioArtistPersonaKind = keyof typeof STUDIO_FORMAT_BY_KIND;

export const STUDIO_ARTIST_PERSONA_KINDS = Object.keys(
  STUDIO_FORMAT_BY_KIND,
) as readonly StudioArtistPersonaKind[];

/** What a persona kind changed outside the artist kinds reads as on the
 *  wire (the v1 rule); the API itself never changes a persona's kind. */
export const STUDIO_FALLBACK_ARTIST_PERSONA_KIND: StudioArtistPersonaKind =
  'musician';

// Studio artist kinds add the podcast show and the two performance types,
// in the order the enum migration appends the labels.
export const STUDIO_RELEASE_TYPES = [
  'album',
  'ep',
  'single',
  'mix',
  'podcast',
  'edit',
  'lip_sync',
] as const;
export type StudioReleaseTypeValue = (typeof STUDIO_RELEASE_TYPES)[number];

// Studio v3 adds `scheduled` between `draft` and `published`, in the order
// the enum migration places the label (`ADD VALUE ... BEFORE 'published'`).
export const STUDIO_RELEASE_STATUSES = [
  'draft',
  'scheduled',
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

// Collaborative playlists (QUEERPULSE-STUDIO-COLLAB-PLAYLISTS-CONTRACT-2026-10-14.md):
// the role a viewer holds on one playlist. `null` on the wire for everyone
// else.
export const STUDIO_PLAYLIST_ROLES = ['owner', 'editor', 'invitee'] as const;
export type StudioPlaylistRole = (typeof STUDIO_PLAYLIST_ROLES)[number];

/** Stats counts from 1 to `STUDIO_STATS_THRESHOLD - 1` are withheld. */
export const STUDIO_STATS_THRESHOLD = 5;

// Studio landing v2: the states of a track preview on the public Studio page.
export const STUDIO_LANDING_PREVIEW_STATUSES = [
  'pending',
  'approved',
  'declined',
  'withdrawn',
] as const;
export type StudioLandingPreviewStatus =
  (typeof STUDIO_LANDING_PREVIEW_STATUSES)[number];

// Studio landing v2: the two photo slots staff fill on the Studio page.
export const STUDIO_LANDING_PHOTO_SLOTS = ['hero', 'manifesto'] as const;
export type StudioLandingPhotoSlot =
  (typeof STUDIO_LANDING_PHOTO_SLOTS)[number];

// Studio landing v2: the join-request source a signup from each Studio page carries.
export const STUDIO_LANDING_JOIN_SOURCES = {
  listener: 'studio_landing',
  artist: 'studio_artist',
} as const;

// Studio v3 artist tools (QUEERPULSE-STUDIO-V3-ARTIST-TOOLS-CONTRACT-2026-10-13.md).

/** The persona social link platforms a release and an artist page show as
 *  "Support". Read from `subprofile_social_links`; no new persona field. */
export const STUDIO_SUPPORT_PLATFORMS = [
  'bandcamp',
  'kofi',
  'patreon',
] as const;
export type StudioSupportPlatform = (typeof STUDIO_SUPPORT_PLATFORMS)[number];

/** A scheduled release goes live between 15 minutes and 365 days ahead. */
export const STUDIO_SCHEDULE_MIN_LEAD_MINUTES = 15;
export const STUDIO_SCHEDULE_MAX_LEAD_DAYS = 365;
/** Only used to fill an empty `releasedOn` from `publishAt`. */
export const STUDIO_SCHEDULE_TIME_ZONE = 'Europe/Lisbon';

export const STUDIO_VERSION_NOTE_MAX = 280;

export const STUDIO_PRESS = {
  pitchMax: 140,
  bioMax: 1500,
  featuredMax: 5,
  quotesMax: 3,
  quoteMax: 300,
  sourceMax: 80,
  contactMax: 1000,
  releasesShown: 6,
} as const;

// Open demo pages (QUEERPULSE-STUDIO-OPEN-DEMO-PAGES-DESIGN-2026-10-13.md):
// the life of an artist's dispute about a taken-down release.
export const STUDIO_DISPUTE_STATUSES = ['open', 'upheld', 'rejected'] as const;
export type StudioDisputeStatusValue = (typeof STUDIO_DISPUTE_STATUSES)[number];

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
  // Studio artist kinds: the preset of poet and spoken word releases.
  'spoken-word',
  'other',
] as const;
export type StudioGenre = (typeof STUDIO_GENRES)[number];

// Studio discovery (QUEERPULSE-STUDIO-DISCOVERY-CONTRACT-2026-10-13.md).
// Mirrored word for word in the frontend `studio.types.ts`.
export const STUDIO_MOODS = [
  'late-night',
  'euphoric',
  'tender',
  'melancholy',
  'defiant',
  'dreamy',
  'slow-burn',
  'calm',
] as const;
export type StudioMood = (typeof STUDIO_MOODS)[number];

export const STUDIO_CREDIT_ROLES = [
  'featured',
  'producer',
  'co-writer',
  'mixing',
  'mastering',
  'remix',
  'cover-art',
  'other',
] as const;
export type StudioCreditRole = (typeof STUDIO_CREDIT_ROLES)[number];

export const STUDIO_CURATION_SHELVES = [
  'featured',
  'staff_picks',
  'new_this_week',
] as const;
export type StudioCurationShelf = (typeof STUDIO_CURATION_SHELVES)[number];

export const STUDIO_SCENE_STATUSES = ['active', 'archived'] as const;
export type StudioSceneStatus = (typeof STUDIO_SCENE_STATUSES)[number];

export const STUDIO_PERSONA_CREDIT_STATUSES = [
  'pending',
  'accepted',
  'declined',
] as const;
export type StudioPersonaCreditStatus =
  (typeof STUDIO_PERSONA_CREDIT_STATUSES)[number];

/** Lowercase letters and digits in runs joined by single hyphens. */
export const STUDIO_SCENE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const STUDIO_DISCOVERY_LIMITS = {
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
  /** PRD-15: where an artist plays next, on the artist page. */
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
} as const;

export function isStudioMood(value: string): value is StudioMood {
  return (STUDIO_MOODS as readonly string[]).includes(value);
}

export function isStudioCreditRole(value: string): value is StudioCreditRole {
  return (STUDIO_CREDIT_ROLES as readonly string[]).includes(value);
}

export const STUDIO_LIMITS = {
  releaseTitleMaxLength: 120,
  releaseDescriptionMaxLength: 2000,
  // A release carries up to this many genres; the first one leads.
  releaseGenresMax: 5,
  trackTitleMaxLength: 120,
  lyricsMaxLength: 10000,
  creditsMaxRows: 20,
  creditFieldMaxLength: 80,
  audioMaxBytes: 52428800,
  releasesPerPage: 24,
  searchResultsPerType: 20,
  searchQueryMaxLength: 80,
  tracksPerRelease: 50,
  episodesPerShow: 500,
  artistReleasesShown: 100,
  takedownReasonMaxLength: 500,
  playlistNameMaxLength: 80,
  playlistDescriptionMaxLength: 500,
  playlistsPerMember: 100,
  tracksPerPlaylist: 500,
  tracksPerPlaylistAdd: 50,
  playlistsPerPage: 24,
  // Liked songs: one page of the caller's liked tracks.
  likedTracksPerPage: 100,
  playlistsOnTrackPage: 6,
  playlistCoverCount: 4,
  // The new-release fan-out mirrors `SubprofileUpdatesService`: a bound far
  // above any real audience, chunks of one multi-row insert each, and a
  // small pool so the fan-out leaves most database connections free.
  followerAlertMaxRecipients: 5000,
  followerAlertChunkSize: 500,
  followerAlertConcurrentChunks: 3,
  // Studio v3.
  buyUrlMaxLength: 1000,
  upcomingReleasesShown: 6,
  // Releases the once-a-minute drop publishes per tick; the rest wait a
  // minute, keeping their intended `published_at`.
  scheduledReleasesPerTick: 100,
  // Open demo pages: an artist's note and the staff reply, the lifetime
  // dispute cap per release, and the flag-review page size.
  disputeNoteMaxLength: 1000,
  disputeReplyMaxLength: 1000,
  disputesPerRelease: 3,
  staffItemsPerPage: 20,
  // Studio listening (QUEERPULSE-STUDIO-LISTENING-CONTRACT-2026-10-13.md
  // A.5): what the uploader's browser measures, and the timed lyrics and
  // chapters an owner writes.
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
  // Studio artist kinds: transcripts of podcast and spoken word tracks, show
  // notes and their list excerpt, credited sources, the podcast audio cap
  // with its longer duration read, and the latest-episodes page.
  lyricsMaxLengthLong: 60000,
  notesMaxLength: 4000,
  notesExcerptMaxLength: 200,
  sourcesMaxRows: 100,
  sourceFieldMaxLength: 120,
  audioMaxBytesPodcast: 262144000,
  audioParseTimeoutLongMilliseconds: 180000,
  episodesPerPage: 12,
  episodesPerPageMax: 24,
  // Collaborative playlists: editors per playlist (invited plus active), the
  // co-owner candidate list, a member slug and the candidate search.
  playlistEditorsMax: 10,
  playlistEditorCandidatesMax: 50,
  playlistEditorSlugMaxLength: 120,
  playlistEditorSearchMaxLength: 80,
  // Studio landing v2: previews shown, open requests, decided previews shown,
  // artist cards, quote, photo alt and credit lengths, founding artists and
  // the access request page size.
  landingPreviewsShown: 5,
  landingOpenPreviewsMax: 10,
  landingDecidedPreviewsShown: 30,
  landingArtistCardsMax: 6,
  landingQuoteMaxLength: 240,
  landingPhotoAltMaxLength: 200,
  landingPhotoCreditMaxLength: 120,
  foundingArtistsMax: 50,
  accessRequestsPageSize: 30,
} as const;

/** The release types each format offers. */
export const STUDIO_RELEASE_TYPES_BY_FORMAT: Readonly<
  Record<StudioFormat, readonly StudioReleaseTypeValue[]>
> = {
  music: ['album', 'ep', 'single'],
  podcast: ['podcast'],
  spoken_word: ['album', 'ep', 'single'],
  performance: ['edit', 'lip_sync'],
};

/** A kind whose types differ from its format's: a DJ publishes mixes. */
const STUDIO_RELEASE_TYPE_OVERRIDES: Readonly<
  Partial<Record<StudioArtistPersonaKind, readonly StudioReleaseTypeValue[]>>
> = {
  dj: ['mix'],
};

export const STUDIO_RELEASE_TYPES_BY_PERSONA_KIND = Object.fromEntries(
  STUDIO_ARTIST_PERSONA_KINDS.map((kind) => [
    kind,
    STUDIO_RELEASE_TYPE_OVERRIDES[kind] ??
      STUDIO_RELEASE_TYPES_BY_FORMAT[STUDIO_FORMAT_BY_KIND[kind]],
  ]),
) as Readonly<
  Record<StudioArtistPersonaKind, readonly StudioReleaseTypeValue[]>
>;

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

export function isStudioFormat(value: string): value is StudioFormat {
  return (STUDIO_FORMATS as readonly string[]).includes(value);
}

/** The format a persona kind publishes under, or null for a kind outside
 *  Studio. */
export function studioFormatForKind(kind: string): StudioFormat | null {
  return isStudioArtistPersonaKind(kind) ? STUDIO_FORMAT_BY_KIND[kind] : null;
}

/** The persona kinds of one format, in map order, for an `IN (...)` filter. */
export function studioPersonaKindsForFormat(
  format: StudioFormat,
): StudioArtistPersonaKind[] {
  return STUDIO_ARTIST_PERSONA_KINDS.filter(
    (kind) => STUDIO_FORMAT_BY_KIND[kind] === format,
  );
}

/** Formats whose lyrics field holds a transcript. */
export const STUDIO_TRANSCRIPT_FORMATS: readonly StudioFormat[] = [
  'podcast',
  'spoken_word',
];

/** The lyrics or transcript cap of a format. The PATCH body allows the
 *  longer cap; the track write applies this one. */
export function studioLyricsMaxLengthFor(format: StudioFormat | null): number {
  return format !== null && STUDIO_TRANSCRIPT_FORMATS.includes(format)
    ? STUDIO_LIMITS.lyricsMaxLengthLong
    : STUDIO_LIMITS.lyricsMaxLength;
}

/** The audio cap of a persona kind, at presign and at confirm. */
export function studioAudioMaxBytesForKind(kind: string | null): number {
  return kind !== null && studioFormatForKind(kind) === 'podcast'
    ? STUDIO_LIMITS.audioMaxBytesPodcast
    : STUDIO_LIMITS.audioMaxBytes;
}

/** The genre a new release starts with: spoken word releases are preset. */
export function studioDefaultGenreForKind(kind: string): StudioGenre | null {
  return studioFormatForKind(kind) === 'spoken_word' ? 'spoken-word' : null;
}

/** The genres a new release starts with: the preset genre alone, or none. */
export function studioDefaultGenresForKind(kind: string): StudioGenre[] {
  const defaultGenre = studioDefaultGenreForKind(kind);
  return defaultGenre === null ? [] : [defaultGenre];
}

/** Release types whose tracks credit their sources before publishing. */
export const STUDIO_SOURCE_RELEASE_TYPES: readonly StudioReleaseTypeValue[] = [
  'mix',
  'edit',
  'lip_sync',
];

export function isSourceRequiredReleaseType(releaseType: string): boolean {
  return (STUDIO_SOURCE_RELEASE_TYPES as readonly string[]).includes(
    releaseType,
  );
}

export type StudioPublishRequirementCode =
  | 'studio_publish_missing_title'
  | 'studio_publish_missing_cover'
  | 'studio_publish_missing_rights'
  | 'studio_publish_missing_tracks'
  | 'studio_publish_tracks_pending'
  | 'studio_publish_missing_sources';

export type StudioErrorCode =
  | 'studio_access_required'
  | 'studio_not_persona_owner'
  | 'studio_persona_kind_not_allowed'
  | StudioPublishRequirementCode
  | 'studio_release_not_draft'
  | 'studio_release_type_mismatch'
  | 'studio_track_order_mismatch'
  | 'studio_track_limit'
  | 'studio_episode_limit'
  | 'studio_audio_unreadable'
  | 'studio_audio_wrong_owner'
  | 'studio_playlist_limit'
  | 'studio_playlist_track_limit'
  | 'studio_playlist_order_mismatch'
  | 'studio_playlist_credit_not_allowed'
  | 'studio_playlist_track_unavailable'
  | 'studio_release_withdrawn'
  | 'studio_release_not_taken_down'
  | 'studio_dispute_already_open'
  | 'studio_dispute_limit_reached'
  | 'studio_dispute_not_open'
  | 'studio_release_has_open_dispute'
  | 'studio_takedown_report_mismatch'
  | 'studio_takedown_report_not_open'
  | 'studio_radio_filter_required'
  | 'studio_scene_not_found'
  | 'studio_credit_candidate_not_found'
  | 'studio_credit_not_found'
  | 'studio_curation_shelf_full'
  | 'studio_curation_already_on_shelf'
  | 'studio_curation_order_mismatch'
  | 'studio_scene_slug_taken'
  | 'studio_scene_order_mismatch'
  | 'studio_scene_cover_changed'
  | 'studio_credit_already_requested'
  | 'studio_credit_limit'
  | 'studio_credit_not_pending'
  | 'studio_credit_not_accepted'
  | 'studio_scene_not_available'
  | 'studio_curation_release_not_published'
  | 'studio_scene_event_not_pinnable'
  | 'studio_credit_persona_not_creditable'
  | 'studio_credit_self_persona'
  | 'studio_release_not_schedulable'
  | 'studio_release_needs_playable_track'
  | 'studio_release_no_changes'
  | 'studio_preview_not_available'
  | 'studio_schedule_out_of_range'
  | 'studio_press_track_not_allowed'
  | 'studio_preview_not_found'
  | 'studio_milestone_not_found'
  | 'studio_supporter_artist_not_found'
  | 'studio_supporter_own_persona'
  | 'studio_supporter_identity_not_yours'
  | 'studio_chapters_out_of_range'
  | 'studio_episode_show_not_published'
  | 'studio_episode_already_published'
  | 'studio_episode_order_locked'
  | 'studio_not_a_podcast'
  | 'studio_playlist_not_found'
  | 'studio_playlist_entry_not_found'
  | 'studio_playlist_invite_not_found'
  | 'studio_playlist_editor_not_found'
  | 'studio_playlist_owner_only'
  | 'studio_playlist_editor_source_mismatch'
  | 'studio_playlist_editor_cap'
  | 'studio_playlist_invite_unavailable'
  | 'studio_playlist_credit_change_removes_editors'
  | 'studio_playlist_editor_ineligible'
  // Studio landing v2: the 23 refusals of the public Studio page, its staff tools and access requests.
  | 'studio_landing_preview_unavailable'
  | 'studio_landing_preview_not_found'
  | 'studio_landing_preview_track_not_eligible'
  | 'studio_landing_preview_exists'
  | 'studio_landing_previews_full'
  | 'studio_landing_preview_no_reachable_owner'
  | 'studio_landing_preview_not_pending'
  | 'studio_landing_preview_not_approved'
  | 'studio_landing_preview_main_persona_only'
  | 'studio_landing_consent_required'
  | 'studio_landing_persona_not_eligible'
  | 'studio_landing_card_exists'
  | 'studio_landing_cards_full'
  | 'studio_landing_card_not_found'
  | 'studio_landing_photo_not_yours'
  | 'studio_landing_order_mismatch'
  | 'studio_founding_persona_not_eligible'
  | 'studio_founding_artist_exists'
  | 'studio_founding_artists_full'
  | 'studio_founding_artist_not_found'
  | 'studio_access_request_exists'
  | 'studio_access_already_granted'
  | 'studio_access_request_not_found'
  // Studio purchases (QUEERPULSE-STUDIO-PURCHASES-CONTRACT-2026-10-28.md section 7).
  | 'studio_persona_not_found'
  | 'studio_release_type_not_for_sale'
  | 'studio_price_out_of_range'
  | 'studio_payment_methods_needed_for_sale'
  | 'studio_payment_methods_limit'
  | 'studio_payment_link_invalid'
  | 'studio_payment_mbway_invalid'
  | 'studio_payment_iban_invalid'
  | 'studio_purchase_item_required'
  | 'studio_purchase_item_not_found'
  | 'studio_purchase_own_persona'
  | 'studio_purchase_not_for_sale'
  | 'studio_purchase_release_not_published'
  | 'studio_purchase_track_unavailable'
  | 'studio_purchase_unavailable'
  | 'studio_purchase_no_payment_methods'
  | 'studio_purchase_pending_exists'
  | 'studio_purchase_already_owned'
  | 'studio_purchase_reference_invalid'
  | 'studio_purchase_reference_taken'
  | 'studio_purchase_amount_below_minimum'
  | 'studio_purchase_amount_above_cap'
  | 'studio_purchase_price_changed'
  | 'studio_purchase_not_found'
  | 'studio_purchase_not_pending'
  | 'studio_purchase_wall_not_available'
  | 'studio_purchase_not_confirmed'
  | 'studio_download_item_deleted'
  | 'studio_download_track_removed'
  | 'studio_download_release_taken_down'
  | 'studio_download_artist_unavailable'
  | 'studio_download_track_withheld'
  | 'studio_download_track_not_ready'
  | 'studio_download_track_preparing'
  | StudioSafetyErrorCode;

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
    message:
      'Only music, podcast, spoken word and performance personas can upload to Studio.',
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
  studio_publish_missing_sources: {
    status: HttpStatus.CONFLICT,
    message: 'Credit every source before publishing.',
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
  studio_episode_limit: {
    status: HttpStatus.CONFLICT,
    message: 'A show holds at most 500 episodes.',
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
      'Show this playlist as yourself or as a Studio artist persona you run that is live in Studio.',
  },
  studio_playlist_track_unavailable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'One of these tracks cannot be played right now.',
  },
  // The 410 a listener gets for a release staff took down. The body carries
  // the code and nothing about the release.
  studio_release_withdrawn: {
    status: HttpStatus.GONE,
    message: 'This release was withdrawn.',
  },
  studio_release_not_taken_down: {
    status: HttpStatus.CONFLICT,
    message: 'Only a release our team took down can be disputed.',
  },
  studio_dispute_already_open: {
    status: HttpStatus.CONFLICT,
    message: 'A dispute about this release is already waiting for our team.',
  },
  studio_dispute_limit_reached: {
    status: HttpStatus.CONFLICT,
    message: 'This release has reached its limit of 3 disputes.',
  },
  studio_dispute_not_open: {
    status: HttpStatus.CONFLICT,
    message: 'This dispute was already decided.',
  },
  // A staff restore while the owners' dispute waits: staff decide it
  // through the uphold, so the dispute and the release move together.
  studio_release_has_open_dispute: {
    status: HttpStatus.CONFLICT,
    message:
      'This release has an open dispute. Decide it in Studio flag review.',
  },
  studio_takedown_report_mismatch: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'That report is not a Studio report about this release.',
  },
  studio_takedown_report_not_open: {
    status: HttpStatus.CONFLICT,
    message: 'That report was already handled.',
  },
  studio_radio_filter_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Choose one genre or one mood for radio.',
  },
  studio_scene_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This scene is not available.',
  },
  studio_credit_candidate_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'No persona with that handle can be credited.',
  },
  studio_credit_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'Credit not found.',
  },
  studio_curation_shelf_full: {
    status: HttpStatus.CONFLICT,
    message: 'A shelf holds up to 12 releases.',
  },
  studio_curation_already_on_shelf: {
    status: HttpStatus.CONFLICT,
    message: 'This release is already on this shelf.',
  },
  studio_curation_order_mismatch: {
    status: HttpStatus.CONFLICT,
    message: 'The new order must list every pick of the shelf once.',
  },
  studio_scene_slug_taken: {
    status: HttpStatus.CONFLICT,
    message: 'Another scene already uses this address.',
  },
  studio_scene_order_mismatch: {
    status: HttpStatus.CONFLICT,
    message: 'The new order must list every active scene once.',
  },
  studio_scene_cover_changed: {
    status: HttpStatus.CONFLICT,
    message:
      'Another staff member changed this scene cover first. Reload the scene and choose the cover again.',
  },
  studio_credit_already_requested: {
    status: HttpStatus.CONFLICT,
    message: 'This persona already has a credit in this role on this track.',
  },
  studio_credit_limit: {
    status: HttpStatus.CONFLICT,
    message: 'A track holds up to 20 persona credits.',
  },
  studio_credit_not_pending: {
    status: HttpStatus.CONFLICT,
    message: 'This credit request was already answered.',
  },
  studio_credit_not_accepted: {
    status: HttpStatus.CONFLICT,
    message: 'Decline a pending request; remove applies to accepted credits.',
  },
  studio_scene_not_available: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Pick an active scene.',
  },
  studio_curation_release_not_published: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Only published releases can go on a shelf.',
  },
  studio_scene_event_not_pinnable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Pin an upcoming published event open to members.',
  },
  studio_credit_persona_not_creditable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This persona cannot be credited.',
  },
  studio_credit_self_persona: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'A release credits other personas; its own persona is already on it.',
  },
  studio_release_not_schedulable: {
    status: HttpStatus.CONFLICT,
    message: 'Only a draft or a scheduled release can be scheduled.',
  },
  studio_release_needs_playable_track: {
    status: HttpStatus.CONFLICT,
    message:
      'A release that is out or scheduled keeps at least one playable track.',
  },
  studio_release_no_changes: {
    status: HttpStatus.CONFLICT,
    message: 'Change the tracks first, then add a version note.',
  },
  studio_preview_not_available: {
    status: HttpStatus.CONFLICT,
    message: 'Preview links are for releases that are still to come.',
  },
  studio_schedule_out_of_range: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Pick a time between 15 minutes and 365 days from now.',
  },
  studio_press_track_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: "Pick tracks from this artist's own releases.",
  },
  studio_preview_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This preview link is not available.',
  },
  studio_milestone_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This milestone is not available to you.',
  },
  studio_supporter_artist_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This artist is not available to support.',
  },
  studio_supporter_own_persona: {
    status: HttpStatus.FORBIDDEN,
    message: 'You are a member of this artist, so you cannot be its supporter.',
  },
  studio_supporter_identity_not_yours: {
    status: HttpStatus.FORBIDDEN,
    message:
      'You can show yourself only as your account or a persona you are a member of.',
  },
  studio_chapters_out_of_range: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Chapters need the track audio first, and each one starts before the track ends.',
  },
  studio_episode_show_not_published: {
    status: HttpStatus.CONFLICT,
    message: 'Publish the show first, then its episodes.',
  },
  studio_episode_already_published: {
    status: HttpStatus.CONFLICT,
    message: 'This episode is already out.',
  },
  studio_episode_order_locked: {
    status: HttpStatus.CONFLICT,
    message: 'Episodes of a published show keep their publish order.',
  },
  studio_not_a_podcast: {
    status: HttpStatus.CONFLICT,
    message: 'Show notes and episodes belong to podcast shows.',
  },
  // Collaborative playlists. The 404 says nothing about why, so a private
  // playlist and a missing one read the same.
  studio_playlist_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This playlist is not available.',
  },
  studio_playlist_entry_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This track is already off the playlist.',
  },
  studio_playlist_invite_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This invitation is no longer open.',
  },
  studio_playlist_editor_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This editor is not on this playlist.',
  },
  studio_playlist_owner_only: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the owner of this playlist can do this.',
  },
  studio_playlist_editor_source_mismatch: {
    status: HttpStatus.CONFLICT,
    message:
      'Playlists shown as a persona take its co-owners as editors, and playlists shown as you take invited connections.',
  },
  studio_playlist_editor_cap: {
    status: HttpStatus.CONFLICT,
    message: 'A playlist can have up to 10 editors, invitations included.',
  },
  studio_playlist_invite_unavailable: {
    status: HttpStatus.CONFLICT,
    message: 'This invitation can no longer be accepted.',
  },
  studio_playlist_credit_change_removes_editors: {
    status: HttpStatus.CONFLICT,
    message: 'Changing who this playlist shows as removes some editors.',
  },
  studio_playlist_editor_ineligible: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Some of these members cannot edit this playlist.',
  },
  // Studio landing v2: the 23 refusals of the public Studio page, its staff tools and access requests.
  studio_landing_preview_unavailable: {
    status: HttpStatus.NOT_FOUND,
    message: 'This preview is not available.',
  },
  studio_landing_preview_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'Preview not found.',
  },
  studio_landing_preview_track_not_eligible: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This track does not meet the rules for the Studio page.',
  },
  studio_landing_preview_exists: {
    status: HttpStatus.CONFLICT,
    message: 'This track already has an open request or a live preview.',
  },
  studio_landing_previews_full: {
    status: HttpStatus.CONFLICT,
    message: 'The Studio page holds up to 10 open previews.',
  },
  studio_landing_preview_no_reachable_owner: {
    status: HttpStatus.CONFLICT,
    message:
      'Nobody who runs this artist has Studio access, so nobody can approve the preview.',
  },
  studio_landing_preview_not_pending: {
    status: HttpStatus.CONFLICT,
    message: 'This request was already answered.',
  },
  studio_landing_preview_not_approved: {
    status: HttpStatus.CONFLICT,
    message: 'This preview is no longer live.',
  },
  studio_landing_preview_main_persona_only: {
    status: HttpStatus.FORBIDDEN,
    message:
      'Only the artist who released this track can approve or decline the request.',
  },
  studio_landing_consent_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Saving needs the consent tick: confirm the people shown agreed.',
  },
  studio_landing_persona_not_eligible: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'This artist cannot appear on the Studio page: their page must be published and public.',
  },
  studio_landing_card_exists: {
    status: HttpStatus.CONFLICT,
    message: 'This artist already has a card.',
  },
  studio_landing_cards_full: {
    status: HttpStatus.CONFLICT,
    message: 'The Studio page holds up to 6 artist cards.',
  },
  studio_landing_card_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'Artist card not found.',
  },
  studio_landing_photo_not_yours: {
    status: HttpStatus.FORBIDDEN,
    message: 'Use a photo you uploaded, or keep the one this slot holds.',
  },
  studio_landing_order_mismatch: {
    status: HttpStatus.CONFLICT,
    message: 'The list changed while you reordered it. Reload and try again.',
  },
  studio_founding_persona_not_eligible: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'This artist cannot be a founding artist: their page must be published and public.',
  },
  studio_founding_artist_exists: {
    status: HttpStatus.CONFLICT,
    message: 'This artist is already a founding artist.',
  },
  studio_founding_artists_full: {
    status: HttpStatus.CONFLICT,
    message: 'The founding list holds up to 50 artists.',
  },
  studio_founding_artist_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'Founding artist not found.',
  },
  studio_access_request_exists: {
    status: HttpStatus.CONFLICT,
    message: 'You already asked for Studio access.',
  },
  studio_access_already_granted: {
    status: HttpStatus.CONFLICT,
    message: 'You already have Studio access.',
  },
  studio_access_request_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This request is no longer waiting.',
  },
  // Studio purchases (QUEERPULSE-STUDIO-PURCHASES-CONTRACT-2026-10-28.md section 7).
  studio_persona_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This artist page is not one you run.',
  },
  studio_release_type_not_for_sale: {
    status: HttpStatus.CONFLICT,
    message: 'Only albums, EPs and singles and their tracks can be sold.',
  },
  studio_price_out_of_range: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'A fixed price runs from €1 to €500, and a minimum from €0 to €500.',
  },
  studio_payment_methods_needed_for_sale: {
    status: HttpStatus.CONFLICT,
    message:
      'Add a way to get paid before putting music up for sale, and keep one while anything is for sale.',
  },
  studio_payment_methods_limit: {
    status: HttpStatus.BAD_REQUEST,
    message: 'An artist can list up to 8 ways to get paid.',
  },
  studio_payment_link_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A payment link must be a full https:// address.',
  },
  studio_payment_mbway_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'MB WAY needs a Portuguese mobile number.',
  },
  studio_payment_iban_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Check the IBAN: the country code, length or check digits do not match.',
  },
  studio_purchase_item_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Choose one release or one track to buy.',
  },
  studio_purchase_item_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This music is not available to you.',
  },
  studio_purchase_own_persona: {
    status: HttpStatus.FORBIDDEN,
    message: 'You are a member of this artist, so you cannot buy its music.',
  },
  studio_purchase_not_for_sale: {
    status: HttpStatus.CONFLICT,
    message: 'This is not for sale.',
  },
  studio_purchase_release_not_published: {
    status: HttpStatus.CONFLICT,
    message: 'This release is not out yet, so it cannot be bought.',
  },
  studio_purchase_track_unavailable: {
    status: HttpStatus.CONFLICT,
    message: 'This track cannot be bought right now.',
  },
  // The one deliberately neutral message: a block in either direction never shows (block exception of the errors-name-the-reason rule).
  studio_purchase_unavailable: {
    status: HttpStatus.FORBIDDEN,
    message: 'You cannot buy music from this artist.',
  },
  studio_purchase_no_payment_methods: {
    status: HttpStatus.CONFLICT,
    message: 'This artist has not added a way to get paid.',
  },
  studio_purchase_pending_exists: {
    status: HttpStatus.CONFLICT,
    message:
      'You already told this artist you paid for this; it is waiting for them.',
  },
  studio_purchase_already_owned: {
    status: HttpStatus.CONFLICT,
    message: 'This is already in your collection.',
  },
  studio_purchase_reference_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'This payment code is too old. Get a new code, and if you already paid with the old one, put the old code in the name field so the artist can match it.',
  },
  studio_purchase_reference_taken: {
    status: HttpStatus.CONFLICT,
    message:
      'This payment code was just taken by another purchase. Get a new code.',
  },
  studio_purchase_amount_below_minimum: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: "The amount is below the artist's minimum.",
  },
  studio_purchase_amount_above_cap: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A purchase can be up to €500.',
  },
  studio_purchase_price_changed: {
    status: HttpStatus.CONFLICT,
    message: 'The price changed. Check the new price and try again.',
  },
  studio_purchase_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This purchase is not available to you.',
  },
  studio_purchase_not_pending: {
    status: HttpStatus.CONFLICT,
    message: 'This purchase was already answered.',
  },
  studio_purchase_wall_not_available: {
    status: HttpStatus.CONFLICT,
    message:
      'The supporter wall is open to pending and confirmed purchases of an artist still on Studio.',
  },
  studio_purchase_not_confirmed: {
    status: HttpStatus.CONFLICT,
    message: 'Downloads open once the artist confirms your payment.',
  },
  studio_download_item_deleted: {
    status: HttpStatus.GONE,
    message:
      'The artist deleted this music, so it can no longer be downloaded.',
  },
  studio_download_track_removed: {
    status: HttpStatus.GONE,
    message: 'This track is no longer on the release.',
  },
  studio_download_release_taken_down: {
    status: HttpStatus.GONE,
    message: 'Our team took this release down, so it cannot be downloaded.',
  },
  studio_download_artist_unavailable: {
    status: HttpStatus.GONE,
    message: 'This artist page was removed, so its music cannot be downloaded.',
  },
  studio_download_track_withheld: {
    status: HttpStatus.GONE,
    message:
      'A copyright claim holds this track offline, so it cannot be downloaded.',
  },
  studio_download_track_not_ready: {
    status: HttpStatus.CONFLICT,
    message: 'This track has no audio yet.',
  },
  studio_download_track_preparing: {
    status: HttpStatus.CONFLICT,
    message: 'We are preparing this file for you. Try again in a few minutes.',
  },
  // Studio safety and moderation: the 14 refusals, one source of truth.
  ...STUDIO_SAFETY_ERRORS,
};

export const STUDIO_ERROR_CODES = Object.keys(
  STUDIO_ERRORS,
) as StudioErrorCode[];

/** The one way Studio refuses a request: `{ statusCode, code, message }`.
 *  A 404 code comes back as a `NotFoundException` and a 403 code as a
 *  `ForbiddenException`, so a caller that tests the class keeps working
 *  when a bare exception gains a code. */
export function studioError(code: StudioErrorCode): HttpException {
  return studioErrorWithDetails(code, {});
}

/** `studioError` with extra body fields, for the refusals that name members
 *  (`studio_playlist_editor_ineligible` carries `memberSlugs` and
 *  `ineligibleMembers`, each member with the reason it cannot edit,
 *  `studio_playlist_credit_change_removes_editors` carries `editors`). The
 *  code, the status and the message always win over a detail of that name. */
export function studioErrorWithDetails(
  code: StudioErrorCode,
  details: Record<string, unknown>,
): HttpException {
  const { status, message } = STUDIO_ERRORS[code];
  const body = { ...details, statusCode: status, code, message };
  if (status === HttpStatus.NOT_FOUND) {
    return new NotFoundException(body);
  }
  if (status === HttpStatus.FORBIDDEN) {
    return new ForbiddenException(body);
  }
  return new HttpException(body, status);
}

/** `mod_audit_logs.action` values the Studio staff routes write. */
export const STUDIO_AUDIT_ACTIONS = {
  accessGranted: 'studio_access_granted',
  accessRevoked: 'studio_access_revoked',
  releaseTakenDown: 'studio_release_taken_down',
  releaseRestored: 'studio_release_restored',
  disputeUpheld: 'studio_release_dispute_upheld',
  disputeRejected: 'studio_release_dispute_rejected',
  // Studio safety and moderation.
  ...STUDIO_SAFETY_AUDIT_ACTIONS,
} as const;
