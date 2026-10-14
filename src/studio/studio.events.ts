import { StudioReleaseDisputeDecision } from './entities/studio-release-dispute.entity';

/**
 * Studio v2. Emitted by `StudioReleasesService.publish` once its transaction
 * has committed, so a listener never sees a release that could still roll
 * back. `StudioReleaseAlertsListener` tells the persona's followers.
 */
export const STUDIO_RELEASE_PUBLISHED = 'studio.release.published';

export interface StudioReleasePublishedEvent {
  releaseId: string;
}

/**
 * Open demo pages. Emitted by `StudioModerationService.takedown` once its
 * transaction has committed, and only when the release changed to
 * `taken_down` (a repeated takedown emits nothing).
 * `StudioReleaseNoticesListener` tells the persona's owners.
 */
export const STUDIO_RELEASE_TAKEN_DOWN = 'studio.release.taken_down';

export interface StudioReleaseTakenDownEvent {
  releaseId: string;
}

/**
 * Open demo pages. Emitted by `StudioDisputesService` once an uphold or a
 * reject has committed. `StudioReleaseNoticesListener` tells the persona's
 * owners; the staff reply stays on the release page.
 */
export const STUDIO_RELEASE_DISPUTE_DECIDED = 'studio.release.dispute_decided';

export interface StudioReleaseDisputeDecidedEvent {
  releaseId: string;
  disputeId: string;
  outcome: StudioReleaseDisputeDecision;
}

/**
 * Studio artist kinds. Emitted by `StudioEpisodesService.publishEpisode` once
 * its transaction has committed. `StudioEpisodeAlertsListener` tells the
 * show's followers, once per episode (`studio_tracks.followers_notified_at`).
 * A show publish never emits it: the episodes it carries ride the release
 * alert.
 */
export const STUDIO_EPISODE_PUBLISHED = 'studio.episode.published';

export interface StudioEpisodePublishedEvent {
  trackId: string;
}
