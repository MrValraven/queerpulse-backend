import { toImageUrl } from '../common/image-url';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import { StudioReleaseVersion } from './entities/studio-release-version.entity';
import {
  StudioChapter,
  StudioCredit,
  StudioSource,
  StudioSyncedLyricLine,
  StudioTrack,
} from './entities/studio-track.entity';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import {
  STUDIO_FALLBACK_ARTIST_PERSONA_KIND,
  STUDIO_FORMAT_BY_KIND,
  STUDIO_LIMITS,
  StudioArtistPersonaKind,
  StudioFormat,
  StudioGenre,
  StudioMood,
  isStudioArtistPersonaKind,
  isStudioMood,
} from './studio.constants';
import {
  byEpisodeOrder,
  isDraftEpisode,
  isTrackReleasedToListeners,
  toNotesExcerpt,
} from './studio-episode-rule';
import type {
  StudioPersonaCreditPublic,
  StudioReleaseCreditSummary,
} from './studio-persona-credit-response';
import { StudioSupportLink } from './studio-support-links';
import {
  StudioTrackMeasurements,
  hasTrackAnalysis,
} from './studio-track-listening';
import type { StudioOwnerClaim } from './studio-claim-response';
import {
  StudioContentWarningId,
  effectiveContentWarnings,
  normalizeContentWarnings,
} from './studio-safety.constants';

// Wire shapes of the Studio v1 contract. Backend names end in `Response`
// where the contract name would clash with an entity.

/** The persona columns every artist reference reads, and nothing more: no
 *  owner id ever reaches a Studio response. */
export type StudioArtistPersona = Pick<
  Subprofile,
  'id' | 'handle' | 'displayName' | 'kind' | 'avatarUrl'
>;

export interface StudioArtistRef {
  id: string;
  handle: string;
  name: string;
  kind: StudioArtistPersonaKind;
  avatarUrl: string | null;
}

/** Studio artist kinds: the artist page header and a search artist row carry
 *  the format their kind maps to (`STUDIO_FORMAT_BY_KIND`). Every other
 *  artist reference carries the kind, which the frontend maps the same way. */
export type StudioFormatArtistRef = StudioArtistRef & { format: StudioFormat };

export interface StudioTrackSummary {
  id: string;
  position: number;
  title: string;
  durationSeconds: number | null;
  isExplicit: boolean;
  hasAudio: boolean;
  /** Studio artist kinds: when a podcast episode came out; null on a draft
   *  episode and on every other release type. */
  publishedAt: string | null;
  /** True on the owner's rows of an episode that is not published yet. */
  isDraft: boolean;
  /** The start of the show notes, for an episode row. */
  notesExcerpt: string | null;
  /** Studio safety: the artist's and our team's warnings together, each
   *  once, in theme order. */
  contentWarnings: StudioContentWarningId[];
  /** Studio safety: true while a copyright claim holds the track offline. A
   *  listener's row is then redacted (`toWithheldListenerSummary`). */
  isWithheld: boolean;
}

/** Studio listening: what the release editor needs to prefill a track and
 *  to know which tracks still need measuring. Owner rows only. */
export interface StudioOwnerTrackFields {
  hasAnalysis: boolean;
  /** Contract F.3: the release editor's loudness note reads the pair. */
  loudnessLufs: number | null;
  peakDb: number | null;
  syncedLyrics: StudioSyncedLyricLine[] | null;
  chapters: StudioChapter[] | null;
  /** Studio safety: what the artist's PATCH set. */
  artistContentWarnings: StudioContentWarningId[];
  /** Studio safety: what our team added; locked chips in the editor. */
  staffContentWarnings: StudioContentWarningId[];
  /** Studio safety: our team marked the track explicit. */
  isExplicitLocked: boolean;
}

export type StudioOwnerTrackSummary = StudioTrackSummary &
  StudioOwnerTrackFields;

/** Studio discovery: the scene a card links to. */
export interface StudioSceneRef {
  slug: string;
  name: string;
}

export interface StudioReleaseCard {
  id: string;
  title: string;
  type: StudioReleaseType;
  coverUrl: string | null;
  releasedOn: string | null;
  trackCount: number;
  totalDurationSeconds: number;
  artist: StudioArtistRef;
  /** Studio v2: the server's publish time. Play all keeps the server order
   *  (`published_at desc, id desc`), so the client never sorts. */
  publishedAt: string | null;
  /** Studio v2: on every card, for the browse page. */
  genre: string | null;
  /** Studio discovery: a stored value outside `STUDIO_MOODS` reads as null. */
  mood: StudioMood | null;
  /** Studio discovery: null when unset or when the scene is archived. */
  scene: StudioSceneRef | null;
  /** Studio artist kinds: the format of the persona's kind. */
  format: StudioFormat;
}

export type StudioOwnerReleaseCard = StudioReleaseCard & {
  status: StudioReleaseStatus;
  takedownReason: string | null;
  /** Studio v3: set while the release is scheduled. */
  publishAt: string | null;
};

/** Studio v3: a version note on the wire. Version 1 has none. */
export interface StudioReleaseVersionResponse {
  version: number;
  note: string;
  createdAt: string;
}

export type StudioReleaseVersionRow = Pick<
  StudioReleaseVersion,
  'version' | 'note' | 'createdAt'
>;

/**
 * Studio v3: what a release response reads beside the release row, loaded
 * by `StudioReleaseExtrasService`. `versions` is newest first.
 */
export interface StudioReleaseExtras {
  supportLinks: StudioSupportLink[];
  versions: StudioReleaseVersionRow[];
  isReminderSet: boolean;
}

export const EMPTY_RELEASE_EXTRAS: StudioReleaseExtras = {
  supportLinks: [],
  versions: [],
  isReminderSet: false,
};

/** Who reads a release: its owner, staff (owner fields, `isOwner` false),
 *  or a listener; `isPreview` marks a read through a private preview link. */
export interface StudioReleaseViewer {
  isOwner: boolean;
  isStaff: boolean;
  isPreview?: boolean;
}

/** Studio v3: a scheduled release on the artist page's Upcoming card. */
export type StudioUpcomingRelease = StudioReleaseCard & {
  publishAt: string;
  isReminderSet: boolean;
};

export interface StudioPreviewLink {
  token: string;
  createdAt: string;
}

/** `GET /studio/previews/:token`: the release while it is still to come,
 *  the release id once it is out. */
export type StudioPreviewResult =
  | { release: StudioReleaseResponse; publishedReleaseId: null }
  | { release: null; publishedReleaseId: string };

/** Studio open demo pages: the owner's view of a dispute on their release. */
export interface StudioReleaseDisputeView {
  id: string;
  status: StudioReleaseDisputeStatus;
  note: string;
  staffReply: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface StudioReleaseResponse extends StudioReleaseCard {
  description: string | null;
  status: StudioReleaseStatus;
  /** Owner rows (`isOwner: true`) also carry `StudioOwnerTrackFields`;
   *  listener and staff rows carry the summary only. */
  tracks: (StudioTrackSummary & Partial<StudioOwnerTrackFields>)[];
  isOwner: boolean;
  rightsConfirmedAt: string | null;
  takedownReason: string | null;
  /** Studio open demo pages: the latest dispute, for owners only; null for
   *  listeners and in the staff view. */
  dispute: StudioReleaseDisputeView | null;
  /** Whether the caller may file a dispute right now. */
  canDispute: boolean;
  /** Studio discovery: the owner's stored scene, kept while the scene is
   *  archived so the editor can show it; null for everyone else. */
  sceneId: string | null;
  /** Studio discovery: the album page "Credits" summary. */
  personaCredits: StudioReleaseCreditSummary[];
  /** Studio v3. */
  publishAt: string | null;
  buyUrl: string | null;
  /** Studio listening: "Play without gaps", the same for every viewer. */
  isGapless: boolean;
  supportLinks: StudioSupportLink[];
  version: number;
  versions: StudioReleaseVersionResponse[];
  isReminderSet: boolean;
  isPreview: boolean;
  // Owner-only, false or null for everyone else (staff included).
  hasUnnotedChanges: boolean;
  previewToken: string | null;
  previewLinkCreatedAt: string | null;
  /** Studio safety: owner-visible copyright claims on every track of the
   *  release, newest accepted first. Owners only; empty for everyone else. */
  claims: StudioOwnerClaim[];
}

export interface StudioTrackResponse extends StudioTrackSummary {
  releaseId: string;
  credits: StudioCredit[];
  lyrics: string | null;
  /** Studio listening: the same for listeners and owners. */
  syncedLyrics: StudioSyncedLyricLine[] | null;
  chapters: StudioChapter[] | null;
  release: StudioReleaseCard;
  /** Studio discovery: accepted credits to public personas only. */
  personaCredits: StudioPersonaCreditPublic[];
  /** Studio artist kinds: show notes, on podcast episodes only. */
  notes: string | null;
  /** The credited sources of an edit, a lip-sync mix or a mix. */
  sources: StudioSource[];
  /** Studio safety: owner-visible copyright claims on this track. Owners
   *  only; empty for everyone else. */
  claims: StudioOwnerClaim[];
}

export interface StudioArtistResponse {
  artist: StudioFormatArtistRef & { bio: string | null; city: string | null };
  releases: StudioReleaseCard[];
  ownerReleases: StudioOwnerReleaseCard[] | null;
  /** Studio v2: every follower of the persona, already public on its page. */
  followerCount: number;
  /** Studio v2: whether the caller follows the persona. */
  isFollowing: boolean;
  /** Studio v3: the persona's Bandcamp, Ko-fi and Patreon links. */
  supportLinks: StudioSupportLink[];
  /** Studio v3: scheduled releases, soonest first, max 6. */
  upcoming: StudioUpcomingRelease[];
}

export interface StudioMe {
  hasAccess: boolean;
  uploadablePersonas: StudioArtistRef[];
}

export interface StudioPage<Item> {
  items: Item[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface StudioSearchResult {
  releases: StudioReleaseCard[];
  tracks: (StudioTrackSummary & { release: StudioReleaseCard })[];
  artists: StudioFormatArtistRef[];
}

/** `GET /studio/genres`: genres with at least one release the caller can
 *  hear, in `STUDIO_GENRES` order. No counts. `covers` maps a listed genre
 *  to the card `coverUrl` of its newest such release with a cover; a genre
 *  with no cover is absent, so the object may be empty. */
export interface StudioGenres {
  genres: StudioGenre[];
  covers: Record<string, string>;
}

/** `GET /studio/moods`: moods with at least one release the caller can
 *  hear, in `STUDIO_MOODS` order. No counts. `covers` reads as on
 *  `StudioGenres`, keyed by mood. */
export interface StudioMoods {
  moods: StudioMood[];
  covers: Record<string, string>;
}

/** `GET /studio/formats`: formats with at least one release the caller can
 *  hear, in `STUDIO_FORMATS` order. No counts. */
export interface StudioFormats {
  formats: StudioFormat[];
}

export interface StudioStream {
  url: string;
  expiresAt: string;
  /** Studio listening: 200 integers from 0 to 255, or null until measured. */
  waveformPeaks: number[] | null;
  /** One decimal each; both null until measured. */
  loudnessLufs: number | null;
  peakDb: number | null;
  /** Studio listening: on a gapless release, the nearest earlier playable
   *  track this one follows without a crossfade; null everywhere else. */
  gaplessAfterTrackId: string | null;
}

export interface StudioReleaseStats {
  trackCount: number;
  totalDurationSeconds: number;
}

export const EMPTY_RELEASE_STATS: StudioReleaseStats = {
  trackCount: 0,
  totalDurationSeconds: 0,
};

export function hasPlayableAudio(
  track: Pick<StudioTrack, 'audioKey' | 'durationSeconds'>,
): boolean {
  return track.audioKey !== null && track.durationSeconds !== null;
}

/** Studio artist kinds: what a listener may play. Audio in place and, on a
 *  podcast show, an episode whose publish time has come. The SQL twin is
 *  `playableTrackAudioSql`. */
export function isListenerPlayableTrack(
  track: Pick<StudioTrack, 'audioKey' | 'durationSeconds'> &
    Partial<Pick<StudioTrack, 'publishedAt'>>,
  release: Partial<Pick<StudioRelease, 'type'>>,
  now: Date = new Date(),
): boolean {
  return (
    hasPlayableAudio(track) && isTrackReleasedToListeners(track, release, now)
  );
}

export function statsForTracks(
  tracks: Pick<StudioTrack, 'audioKey' | 'durationSeconds'>[],
): StudioReleaseStats {
  return {
    trackCount: tracks.length,
    totalDurationSeconds: tracks
      .filter(hasPlayableAudio)
      .reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
  };
}

/** Studio safety: whether a copyright claim holds the track offline. Reads
 *  a row loaded before the safety columns as not withheld. */
export function isWithheldTrack(
  track: Partial<Pick<StudioTrack, 'withheldAt'>>,
): boolean {
  return Boolean(track.withheldAt);
}

/** Studio safety: a listener's card counts a withheld track (its row stays
 *  in the tracklist) and leaves its length out (nothing of it plays). */
export function listenerStatsForTracks(
  tracks: Pick<StudioTrack, 'audioKey' | 'durationSeconds' | 'withheldAt'>[],
): StudioReleaseStats {
  return {
    trackCount: tracks.length,
    totalDurationSeconds: tracks
      .filter((track) => hasPlayableAudio(track) && !isWithheldTrack(track))
      .reduce((total, track) => total + (track.durationSeconds ?? 0), 0),
  };
}

/** Studio safety: a listener's row for a withheld track keeps its id, its
 *  place and its publish time and drops everything else, the way the 410
 *  track page names nothing. The frontend reads "Unavailable". */
export function toWithheldListenerSummary(
  summary: StudioTrackSummary,
): StudioTrackSummary {
  return {
    ...summary,
    title: '',
    durationSeconds: null,
    isExplicit: false,
    hasAudio: false,
    isDraft: false,
    notesExcerpt: null,
    contentWarnings: [],
    isWithheld: true,
  };
}

/** A kind changed in the database outside the artist kinds reads as
 *  `STUDIO_FALLBACK_ARTIST_PERSONA_KIND`; the API itself never changes a
 *  persona's kind. */
export function toStudioArtistRef(
  persona: StudioArtistPersona,
): StudioArtistRef {
  return {
    id: persona.id,
    handle: persona.handle ?? '',
    name: persona.displayName,
    kind: isStudioArtistPersonaKind(persona.kind)
      ? persona.kind
      : STUDIO_FALLBACK_ARTIST_PERSONA_KIND,
    avatarUrl: toImageUrl(persona.avatarUrl),
  };
}

/** The artist page header and a search artist row (Studio artist kinds). */
export function toStudioFormatArtistRef(
  persona: StudioArtistPersona,
): StudioFormatArtistRef {
  const artist = toStudioArtistRef(persona);
  return { ...artist, format: STUDIO_FORMAT_BY_KIND[artist.kind] };
}

export function toStudioTrackSummary(track: StudioTrack): StudioTrackSummary {
  return {
    id: track.id,
    position: track.position,
    title: track.title,
    durationSeconds: track.durationSeconds,
    isExplicit: track.isExplicit,
    hasAudio: hasPlayableAudio(track),
    publishedAt: track.publishedAt ? track.publishedAt.toISOString() : null,
    isDraft: false,
    notesExcerpt: toNotesExcerpt(track.notes),
    contentWarnings: effectiveContentWarnings(
      track.contentWarnings,
      track.staffContentWarnings,
    ),
    isWithheld: isWithheldTrack(track),
  };
}

export function toStudioOwnerTrackSummary(
  track: StudioTrack,
): StudioOwnerTrackSummary {
  return {
    ...toStudioTrackSummary(track),
    hasAnalysis: hasTrackAnalysis(track),
    loudnessLufs: track.loudnessLufs ?? null,
    peakDb: track.peakDb ?? null,
    syncedLyrics: track.syncedLyrics ?? null,
    chapters: track.chapters ?? null,
    artistContentWarnings: normalizeContentWarnings(track.contentWarnings),
    staffContentWarnings: normalizeContentWarnings(track.staffContentWarnings),
    isExplicitLocked: Boolean(track.explicitLockedAt),
  };
}

/** The stream body: the signed link, what the upload measured and the
 *  track this one plays straight after (`findGaplessAfterTrackId`). */
export function toStudioStream(
  signedStream: { url: string; expiresAt: string },
  track: StudioTrackMeasurements,
  gaplessAfterTrackId: string | null = null,
): StudioStream {
  return {
    url: signedStream.url,
    expiresAt: signedStream.expiresAt,
    waveformPeaks: track.waveformPeaks ?? null,
    loudnessLufs: track.loudnessLufs ?? null,
    peakDb: track.peakDb ?? null,
    gaplessAfterTrackId,
  };
}

/** An active scene as a card link; an archived or missing one is null. */
export function toStudioSceneRef(
  scene: Pick<StudioScene, 'slug' | 'name' | 'status'> | null | undefined,
): StudioSceneRef | null {
  return scene && scene.status === StudioSceneState.Active
    ? { slug: scene.slug, name: scene.name }
    : null;
}

export function toStudioReleaseCard(
  release: StudioRelease,
  persona: StudioArtistPersona,
  stats: StudioReleaseStats,
): StudioReleaseCard {
  const artist = toStudioArtistRef(persona);
  return {
    id: release.id,
    title: release.title,
    type: release.type,
    coverUrl: toImageUrl(release.coverKey),
    releasedOn: release.releasedOn,
    trackCount: stats.trackCount,
    totalDurationSeconds: stats.totalDurationSeconds,
    artist,
    publishedAt: release.publishedAt ? release.publishedAt.toISOString() : null,
    genre: release.genre,
    mood: release.mood && isStudioMood(release.mood) ? release.mood : null,
    scene: toStudioSceneRef(release.scene),
    format: STUDIO_FORMAT_BY_KIND[artist.kind],
  };
}

export function toStudioOwnerReleaseCard(
  release: StudioRelease,
  persona: StudioArtistPersona,
  stats: StudioReleaseStats,
): StudioOwnerReleaseCard {
  return {
    ...toStudioReleaseCard(release, persona, stats),
    status: release.status,
    takedownReason: release.takedownReason,
    publishAt: release.publishAt ? release.publishAt.toISOString() : null,
  };
}

function byPosition(leftTrack: StudioTrack, rightTrack: StudioTrack): number {
  return leftTrack.position - rightTrack.position;
}

/** Studio v3: what a listener sees of a tracklist. A track still uploading
 *  is left out and the rest are numbered from 1 in stored order. Studio
 *  artist kinds: with its release, a podcast show also leaves out the
 *  episodes not yet published and numbers the rest by publish order, so a
 *  position is an episode number. A preview passes no release: the show is
 *  not out yet, so every episode with audio is listed. */
export function toListenerTrackSummaries(
  tracks: StudioTrack[],
  release?: Partial<Pick<StudioRelease, 'type'>>,
  now: Date = new Date(),
): StudioTrackSummary[] {
  const playableTracks = [...tracks]
    .sort(byPosition)
    .filter((track) =>
      release
        ? isListenerPlayableTrack(track, release, now)
        : hasPlayableAudio(track),
    );
  const orderedTracks =
    release?.type === StudioReleaseType.Podcast
      ? playableTracks.sort(byEpisodeOrder)
      : playableTracks;
  // Studio safety: a withheld track keeps its row and its number, redacted.
  return orderedTracks.map((track, index) => {
    const summary = { ...toStudioTrackSummary(track), position: index + 1 };
    return isWithheldTrack(track)
      ? toWithheldListenerSummary(summary)
      : summary;
  });
}

/**
 * Studio v3: whether the tracks changed after the release went out and
 * after its newest version note. Only changes made while the release is
 * published are stamped, so a republish starts clean.
 */
export function hasUnnotedTrackChanges(
  release: Pick<StudioRelease, 'status' | 'tracksChangedAt' | 'publishedAt'>,
  latestVersionCreatedAt: Date | null,
): boolean {
  if (
    release.status !== StudioReleaseStatus.Published ||
    !release.tracksChangedAt
  ) {
    return false;
  }
  const baseline = Math.max(
    release.publishedAt?.getTime() ?? 0,
    latestVersionCreatedAt?.getTime() ?? 0,
  );
  return release.tracksChangedAt.getTime() > baseline;
}

export function toStudioReleaseVersionResponse(
  row: StudioReleaseVersionRow,
): StudioReleaseVersionResponse {
  return {
    version: row.version,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toStudioReleaseDisputeView(
  dispute: StudioReleaseDispute,
): StudioReleaseDisputeView {
  return {
    id: dispute.id,
    status: dispute.status,
    note: dispute.note,
    staffReply: dispute.staffReply,
    createdAt: dispute.createdAt.toISOString(),
    decidedAt: dispute.decidedAt ? dispute.decidedAt.toISOString() : null,
  };
}

/**
 * Studio open demo pages: an owner may dispute a release staff took down
 * while no dispute about it is open and fewer than
 * `STUDIO_LIMITS.disputesPerRelease` exist. `StudioDisputesService.file`
 * checks the same rule under the release lock.
 */
export function canFileStudioDispute(
  release: Pick<StudioRelease, 'status'>,
  disputes: readonly Pick<StudioReleaseDispute, 'status'>[],
): boolean {
  return (
    release.status === StudioReleaseStatus.TakenDown &&
    !disputes.some(
      (dispute) => dispute.status === StudioReleaseDisputeStatus.Open,
    ) &&
    disputes.length < STUDIO_LIMITS.disputesPerRelease
  );
}

// Newest first by `createdAt`, then `id`, matching the catalog's read.
function latestDispute(
  disputes: readonly StudioReleaseDispute[],
): StudioReleaseDispute | undefined {
  return [...disputes].sort(
    (leftDispute, rightDispute) =>
      rightDispute.createdAt.getTime() - leftDispute.createdAt.getTime() ||
      rightDispute.id.localeCompare(leftDispute.id),
  )[0];
}

/** `viewer.isStaff` is the admin routes' view: owner-only fields filled,
 *  `isOwner` false. `ownerDisputes` are the release's disputes, which the
 *  catalog reads for owners only; the dispute fields reach owners only.
 *  `personaCredits` (Studio discovery) is the album page "Credits"
 *  summary, which the catalog reads for every viewer.
 *  Studio v3: listeners get playable tracks only, renumbered from 1, and no
 *  tracks at all on a scheduled release (a preview link shows them); the
 *  counts on their card follow what they can play. `extras` holds the
 *  support links, version notes and reminder state.
 *  Studio artist kinds: a podcast show gives listeners its published
 *  episodes, numbered by publish order, and marks the owner's unpublished
 *  ones `isDraft`.
 *  Studio safety: listeners get a withheld row redacted in place, counted,
 *  with its length left out; `ownerClaims` reach owners only. */
export function toStudioReleaseResponse(
  release: StudioRelease,
  persona: StudioArtistPersona,
  tracks: StudioTrack[],
  viewer: StudioReleaseViewer,
  ownerDisputes: readonly StudioReleaseDispute[] = [],
  personaCredits: StudioReleaseCreditSummary[] = [],
  extras: StudioReleaseExtras = EMPTY_RELEASE_EXTRAS,
  ownerClaims: readonly StudioOwnerClaim[] = [],
): StudioReleaseResponse {
  const ownersLatestDispute = viewer.isOwner
    ? latestDispute(ownerDisputes)
    : undefined;
  const orderedTracks = [...tracks].sort(byPosition);
  const canSeeOwnerFields = viewer.isOwner || viewer.isStaff;
  const isPreview = viewer.isPreview === true;
  const isScheduled = release.status === StudioReleaseStatus.Scheduled;
  // Studio artist kinds: listeners hear published episodes only; a preview
  // shows a show that is not out yet, so it keeps the audio rule alone.
  const listenerRelease = isPreview ? undefined : release;
  const countedTracks = canSeeOwnerFields
    ? orderedTracks
    : orderedTracks.filter((track) =>
        listenerRelease
          ? isListenerPlayableTrack(track, listenerRelease)
          : hasPlayableAudio(track),
      );
  let wireTracks: (StudioTrackSummary & Partial<StudioOwnerTrackFields>)[];
  if (canSeeOwnerFields) {
    wireTracks = orderedTracks.map((track) =>
      viewer.isOwner
        ? {
            ...toStudioOwnerTrackSummary(track),
            isDraft: isDraftEpisode(track, release),
          }
        : toStudioTrackSummary(track),
    );
  } else if (isScheduled && !isPreview) {
    wireTracks = [];
  } else {
    wireTracks = toListenerTrackSummaries(orderedTracks, listenerRelease);
  }
  const latestVersion = extras.versions[0] ?? null;
  return {
    ...toStudioReleaseCard(
      release,
      persona,
      canSeeOwnerFields
        ? statsForTracks(countedTracks)
        : listenerStatsForTracks(countedTracks),
    ),
    description: release.description,
    status: release.status,
    tracks: wireTracks,
    isOwner: viewer.isOwner,
    rightsConfirmedAt:
      canSeeOwnerFields && release.rightsConfirmedAt
        ? release.rightsConfirmedAt.toISOString()
        : null,
    takedownReason: canSeeOwnerFields ? release.takedownReason : null,
    dispute: ownersLatestDispute
      ? toStudioReleaseDisputeView(ownersLatestDispute)
      : null,
    canDispute: viewer.isOwner && canFileStudioDispute(release, ownerDisputes),
    sceneId: viewer.isOwner ? (release.sceneId ?? null) : null,
    personaCredits,
    publishAt: release.publishAt ? release.publishAt.toISOString() : null,
    buyUrl: release.buyUrl ?? null,
    isGapless: release.isGapless ?? false,
    supportLinks: extras.supportLinks,
    version: latestVersion?.version ?? 1,
    versions: extras.versions.map(toStudioReleaseVersionResponse),
    isReminderSet: isScheduled && extras.isReminderSet,
    isPreview,
    hasUnnotedChanges:
      viewer.isOwner &&
      hasUnnotedTrackChanges(release, latestVersion?.createdAt ?? null),
    previewToken: viewer.isOwner ? (release.previewToken ?? null) : null,
    previewLinkCreatedAt:
      viewer.isOwner && release.previewLinkCreatedAt
        ? release.previewLinkCreatedAt.toISOString()
        : null,
    claims: viewer.isOwner ? [...ownerClaims] : [],
  };
}

/** `viewer.isOwner` marks an unpublished episode as a draft (Studio artist
 *  kinds). Show notes reach the wire on podcast episodes only. */
export function toStudioTrackResponse(
  track: StudioTrack,
  releaseCard: StudioReleaseCard,
  personaCredits: StudioPersonaCreditPublic[] = [],
  viewer: Pick<StudioReleaseViewer, 'isOwner'> = { isOwner: false },
  ownerClaims: readonly StudioOwnerClaim[] = [],
): StudioTrackResponse {
  const isEpisode = releaseCard.type === StudioReleaseType.Podcast;
  return {
    ...toStudioTrackSummary(track),
    isDraft: viewer.isOwner && isDraftEpisode(track, releaseCard),
    releaseId: track.releaseId,
    credits: track.credits,
    lyrics: track.lyrics,
    syncedLyrics: track.syncedLyrics ?? null,
    chapters: track.chapters ?? null,
    release: releaseCard,
    personaCredits,
    notes: isEpisode ? (track.notes ?? null) : null,
    sources: track.sources ?? [],
    claims: viewer.isOwner ? [...ownerClaims] : [],
  };
}
