import { StudioReleaseDispute } from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import {
  StudioArtistPersona,
  StudioReleaseCard,
  StudioReleaseDisputeView,
  StudioReleaseStats,
  toStudioReleaseCard,
  toStudioReleaseDisputeView,
} from './studio-response';

// Studio open demo pages: the wire shapes of the staff flag review
// (`GET /admin/studio/disputes`, `GET /admin/studio/releases?status=taken_down`,
// and the uphold and reject answers). Staff see the persona the release
// belongs to and never the member who runs it, nor which staff member acted.

/** A release as a flag-review card shows it: the release card plus the
 *  takedown facts. */
export type StudioAdminReleaseSummary = StudioReleaseCard & {
  status: StudioReleaseStatus;
  takedownReason: string | null;
  takenDownAt: string | null;
};

export interface StudioAdminDispute extends StudioReleaseDisputeView {
  release: StudioAdminReleaseSummary;
}

/** A row of the Withdrawn tab. `openDisputeId` names the release's open
 *  dispute (a release holds at most one), or null when none is open; the
 *  frontend restores such a release through that dispute's uphold. */
export type StudioAdminWithdrawnRelease = StudioAdminReleaseSummary & {
  openDisputeId: string | null;
};

export function toStudioAdminReleaseSummary(
  release: StudioRelease,
  persona: StudioArtistPersona,
  stats: StudioReleaseStats,
): StudioAdminReleaseSummary {
  return {
    ...toStudioReleaseCard(release, persona, stats),
    status: release.status,
    takedownReason: release.takedownReason,
    takenDownAt: release.takenDownAt ? release.takenDownAt.toISOString() : null,
  };
}

export function toStudioAdminDispute(
  dispute: StudioReleaseDispute,
  release: StudioAdminReleaseSummary,
): StudioAdminDispute {
  return { ...toStudioReleaseDisputeView(dispute), release };
}
