import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { severityWeight } from './admin-communities-response';

export interface CommunityReportTotals {
  totalReportCount: number;
  openReportCount: number;
  overdueOpenReportCount: number;
  severityWeightedOpenLoad: number;
}

function emptyCommunityReportTotals(): CommunityReportTotals {
  return {
    totalReportCount: 0,
    openReportCount: 0,
    overdueOpenReportCount: 0,
    severityWeightedOpenLoad: 0,
  };
}

/**
 * Attribute reports to the communities they belong to.
 *
 * `reports` has no community foreign key — scoping is the `(subjectType,
 * subjectId)` pair, and `subjectId` means something different per subject
 * type:
 *
 * - `community` reports: `subjectId` is the community **slug**, resolved
 *   through `slugToCommunityId`.
 * - `post` and `reply` reports: `subjectId` is a **content id** (a post id or
 *   a reply id — posts and replies live in separate tables but share this one
 *   lookup), resolved through `communityIdBySubjectId`.
 * - `member`, `venue`, and `message` reports have no associated community at
 *   all and are dropped rather than guessed at.
 *
 * CONTRACT FOR CALLERS (Task 3's service, which builds these maps with
 * batched queries): `communityIdBySubjectId` MUST be keyed by BOTH post ids
 * AND reply ids, each mapped to the community that post/reply belongs to. A
 * map built from only one of the two content tables will silently drop the
 * other subject type's reports here — they simply won't be found in the map
 * and will be excluded from every community's totals, with no error raised.
 *
 * @param reports the reports to attribute, unfiltered.
 * @param communityIdBySubjectId post id or reply id → owning community id.
 * @param slugToCommunityId community slug → community id.
 * @param now the instant to evaluate SLA overdue-ness against.
 */
export function summariseReportsByCommunity(
  reports: Report[],
  communityIdBySubjectId: Map<string, string>,
  slugToCommunityId: Map<string, string>,
  now: Date,
): Map<string, CommunityReportTotals> {
  const totalsByCommunityId = new Map<string, CommunityReportTotals>();

  for (const report of reports) {
    const communityId =
      report.subjectType === ReportSubjectType.Community
        ? slugToCommunityId.get(report.subjectId)
        : communityIdBySubjectId.get(report.subjectId);

    if (!communityId) {
      continue;
    }

    const communityReportTotals =
      totalsByCommunityId.get(communityId) ?? emptyCommunityReportTotals();
    communityReportTotals.totalReportCount += 1;

    if (report.status === ReportStatus.Open) {
      communityReportTotals.openReportCount += 1;
      communityReportTotals.severityWeightedOpenLoad += severityWeight(
        report.severity,
      );
      if (report.slaDueAt.getTime() < now.getTime()) {
        communityReportTotals.overdueOpenReportCount += 1;
      }
    }

    totalsByCommunityId.set(communityId, communityReportTotals);
  }

  return totalsByCommunityId;
}
