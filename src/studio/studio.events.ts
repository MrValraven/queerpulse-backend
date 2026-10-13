/**
 * Studio v2. Emitted by `StudioReleasesService.publish` once its transaction
 * has committed, so a listener never sees a release that could still roll
 * back. `StudioReleaseAlertsListener` tells the persona's followers.
 */
export const STUDIO_RELEASE_PUBLISHED = 'studio.release.published';

export interface StudioReleasePublishedEvent {
  releaseId: string;
}
