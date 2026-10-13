import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioReleaseCard, StudioTrackSummary } from './studio-response';
import { STUDIO_STATS_THRESHOLD } from './studio.constants';

/** A count on the stats page. 1 to 4 are withheld (`value: null`), so a
 *  small number never points at a handful of identifiable members. Zero
 *  stays zero. */
export interface StudioCount {
  value: number | null;
  isBelowThreshold: boolean;
}

export interface StudioTrackStatsRow {
  track: StudioTrackSummary;
  saves: StudioCount;
  playlistInclusions: StudioCount;
}

export interface StudioReleaseStatsRow {
  release: StudioReleaseCard & { status: StudioReleaseStatus };
  saves: StudioCount;
  /** Distinct public playlists holding any of the release's tracks. */
  playlistInclusions: StudioCount;
  tracks: StudioTrackStatsRow[];
}

export interface StudioArtistStats {
  subprofileId: string;
  /** Shown as is: already public on the persona page. */
  followerCount: number;
  releases: StudioReleaseStatsRow[];
}

export function toStudioCount(count: number): StudioCount {
  if (count > 0 && count < STUDIO_STATS_THRESHOLD) {
    return { value: null, isBelowThreshold: true };
  }
  return { value: count, isBelowThreshold: false };
}

/** Published releases by `published_at desc, id desc`, then drafts and
 *  taken-down releases by `updated_at desc, id desc`. */
export function orderReleasesForStats(
  releases: StudioRelease[],
): StudioRelease[] {
  const byIdDescending = (left: StudioRelease, right: StudioRelease): number =>
    right.id.localeCompare(left.id);
  const published = releases
    .filter((release) => release.status === StudioReleaseStatus.Published)
    .sort(
      (left, right) =>
        (right.publishedAt?.getTime() ?? 0) -
          (left.publishedAt?.getTime() ?? 0) || byIdDescending(left, right),
    );
  const others = releases
    .filter((release) => release.status !== StudioReleaseStatus.Published)
    .sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        byIdDescending(left, right),
    );
  return [...published, ...others];
}
