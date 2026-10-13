import { toImageUrl } from '../common/image-url';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioCredit, StudioTrack } from './entities/studio-track.entity';
import {
  StudioArtistPersonaKind,
  isStudioArtistPersonaKind,
} from './studio.constants';

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

export interface StudioTrackSummary {
  id: string;
  position: number;
  title: string;
  durationSeconds: number | null;
  isExplicit: boolean;
  hasAudio: boolean;
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
}

export type StudioOwnerReleaseCard = StudioReleaseCard & {
  status: StudioReleaseStatus;
  takedownReason: string | null;
};

export interface StudioReleaseResponse extends StudioReleaseCard {
  description: string | null;
  genre: string | null;
  status: StudioReleaseStatus;
  publishedAt: string | null;
  tracks: StudioTrackSummary[];
  isOwner: boolean;
  rightsConfirmedAt: string | null;
  takedownReason: string | null;
}

export interface StudioTrackResponse extends StudioTrackSummary {
  releaseId: string;
  credits: StudioCredit[];
  lyrics: string | null;
  release: StudioReleaseCard;
}

export interface StudioArtistResponse {
  artist: StudioArtistRef & { bio: string | null; city: string | null };
  releases: StudioReleaseCard[];
  ownerReleases: StudioOwnerReleaseCard[] | null;
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
  artists: StudioArtistRef[];
}

export interface StudioStream {
  url: string;
  expiresAt: string;
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

/** A kind changed in the database outside the artist kinds reads as
 *  `musician`; the API itself never changes a persona's kind. */
export function toStudioArtistRef(
  persona: StudioArtistPersona,
): StudioArtistRef {
  return {
    id: persona.id,
    handle: persona.handle ?? '',
    name: persona.displayName,
    kind: isStudioArtistPersonaKind(persona.kind) ? persona.kind : 'musician',
    avatarUrl: toImageUrl(persona.avatarUrl),
  };
}

export function toStudioTrackSummary(track: StudioTrack): StudioTrackSummary {
  return {
    id: track.id,
    position: track.position,
    title: track.title,
    durationSeconds: track.durationSeconds,
    isExplicit: track.isExplicit,
    hasAudio: hasPlayableAudio(track),
  };
}

export function toStudioReleaseCard(
  release: StudioRelease,
  persona: StudioArtistPersona,
  stats: StudioReleaseStats,
): StudioReleaseCard {
  return {
    id: release.id,
    title: release.title,
    type: release.type,
    coverUrl: toImageUrl(release.coverKey),
    releasedOn: release.releasedOn,
    trackCount: stats.trackCount,
    totalDurationSeconds: stats.totalDurationSeconds,
    artist: toStudioArtistRef(persona),
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
  };
}

/** `viewer.isStaff` is the admin routes' view: owner-only fields filled,
 *  `isOwner` false. */
export function toStudioReleaseResponse(
  release: StudioRelease,
  persona: StudioArtistPersona,
  tracks: StudioTrack[],
  viewer: { isOwner: boolean; isStaff: boolean },
): StudioReleaseResponse {
  const orderedTracks = [...tracks].sort(
    (leftTrack, rightTrack) => leftTrack.position - rightTrack.position,
  );
  const canSeeOwnerFields = viewer.isOwner || viewer.isStaff;
  return {
    ...toStudioReleaseCard(release, persona, statsForTracks(tracks)),
    description: release.description,
    genre: release.genre,
    status: release.status,
    publishedAt: release.publishedAt ? release.publishedAt.toISOString() : null,
    tracks: orderedTracks.map(toStudioTrackSummary),
    isOwner: viewer.isOwner,
    rightsConfirmedAt:
      canSeeOwnerFields && release.rightsConfirmedAt
        ? release.rightsConfirmedAt.toISOString()
        : null,
    takedownReason: canSeeOwnerFields ? release.takedownReason : null,
  };
}

export function toStudioTrackResponse(
  track: StudioTrack,
  releaseCard: StudioReleaseCard,
): StudioTrackResponse {
  return {
    ...toStudioTrackSummary(track),
    releaseId: track.releaseId,
    credits: track.credits,
    lyrics: track.lyrics,
    release: releaseCard,
  };
}
