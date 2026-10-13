import { StudioRelease } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { hasPlayableAudio } from './studio-response';
import { StudioPublishRequirementCode } from './studio.constants';

export type PublishableRelease = Pick<
  StudioRelease,
  'title' | 'coverKey' | 'rightsConfirmedAt'
>;
export type PublishableTrack = Pick<
  StudioTrack,
  'audioKey' | 'durationSeconds'
>;

/**
 * Studio v1 publish rule: a title, a cover, the rights confirmed, and at
 * least one track, every one of them with its audio confirmed (a track still
 * uploading blocks the publish). Listed in the order the upload page's
 * checklist shows them; the service answers the first one.
 */
export function unmetPublishRequirements(
  release: PublishableRelease,
  tracks: PublishableTrack[],
): StudioPublishRequirementCode[] {
  const unmet: StudioPublishRequirementCode[] = [];
  if (!release.title.trim()) {
    unmet.push('studio_publish_missing_title');
  }
  if (!release.coverKey) {
    unmet.push('studio_publish_missing_cover');
  }
  if (!release.rightsConfirmedAt) {
    unmet.push('studio_publish_missing_rights');
  }
  if (tracks.length === 0) {
    unmet.push('studio_publish_missing_tracks');
  } else if (tracks.some((track) => !hasPlayableAudio(track))) {
    unmet.push('studio_publish_tracks_pending');
  }
  return unmet;
}

export function firstUnmetPublishRequirement(
  release: PublishableRelease,
  tracks: PublishableTrack[],
): StudioPublishRequirementCode | null {
  return unmetPublishRequirements(release, tracks)[0] ?? null;
}

/** `YYYY-MM-DD` in UTC, for `released_on`. */
export function toIsoDate(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}
