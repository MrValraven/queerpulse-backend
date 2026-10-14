import { EntityManager } from 'typeorm';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { PublishableTrack } from './studio-publish-rule';
import { hasPlayableAudio } from './studio-response';
import { studioError } from './studio.constants';

/**
 * Studio v3 "edit after publishing": track writes (create, delete, reorder,
 * audio confirm) work on drafts, scheduled releases and published ones.
 * A taken-down release stays frozen.
 */
export const TRACK_EDITABLE_RELEASE_STATUSES: readonly StudioReleaseStatus[] = [
  StudioReleaseStatus.Draft,
  StudioReleaseStatus.Scheduled,
  StudioReleaseStatus.Published,
];

export function isLiveOrUpcomingStatus(status: StudioReleaseStatus): boolean {
  return (
    status === StudioReleaseStatus.Published ||
    status === StudioReleaseStatus.Scheduled
  );
}

export function assertTracksEditable(
  release: Pick<StudioRelease, 'status'>,
): void {
  if (!TRACK_EDITABLE_RELEASE_STATUSES.includes(release.status)) {
    throw studioError('studio_release_not_draft');
  }
}

/** A published or scheduled release keeps the publish rule's promise: at
 *  least one track listeners can play. Studio artist kinds: a published
 *  podcast show keeps a published episode, so a draft episode with audio
 *  does not count. */
export function assertKeepsPlayableTrack(
  release: Pick<StudioRelease, 'status'> & Partial<Pick<StudioRelease, 'type'>>,
  remainingTracks: (PublishableTrack &
    Partial<Pick<StudioTrack, 'publishedAt'>>)[],
): void {
  if (!isLiveOrUpcomingStatus(release.status)) {
    return;
  }
  const isPublishedShow =
    release.type === StudioReleaseType.Podcast &&
    release.status === StudioReleaseStatus.Published;
  const keepsListenerTrack = remainingTracks.some(
    (track) =>
      hasPlayableAudio(track) &&
      (!isPublishedShow || (track.publishedAt ?? null) !== null),
  );
  if (!keepsListenerTrack) {
    throw studioError('studio_release_needs_playable_track');
  }
}

/**
 * `clock_timestamp()` is the moment the statement runs, after the release
 * lock was granted, so a change that waited behind a version note is
 * stamped after it. `now()` would be the transaction's start. Studio artist
 * kinds: a podcast show gains episodes as it goes and has no version notes,
 * so it is never stamped.
 */
export const STAMP_TRACKS_CHANGED_SQL = `UPDATE "studio_releases"
   SET "tracks_changed_at" = clock_timestamp()
 WHERE "id" = $1 AND "status" = 'published' AND "type" <> 'podcast'`;

/** Stamps a track change on a published release, inside the caller's
 *  transaction. Changes before the drop belong to the first version; a
 *  podcast show stays unstamped. */
export async function stampTracksChangedIfPublished(
  manager: EntityManager,
  release: Pick<StudioRelease, 'id' | 'status'> &
    Partial<Pick<StudioRelease, 'type'>>,
): Promise<void> {
  if (
    release.status !== StudioReleaseStatus.Published ||
    release.type === StudioReleaseType.Podcast
  ) {
    return;
  }
  await manager.query(STAMP_TRACKS_CHANGED_SQL, [release.id]);
}

/** Version 1 is the original publish and has no row. */
export function nextVersionNumber(latestVersion: number | null): number {
  return (latestVersion ?? 1) + 1;
}
