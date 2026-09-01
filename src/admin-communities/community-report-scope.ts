import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { severityWeight } from './admin-communities-response';

/**
 * Subject types whose reports can ever be attributed to a community.
 *
 * The single source of truth for that set: `AdminCommunitiesService` fetches
 * exactly these (its `subject_type IN (...)` clause) and attributes them
 * through the function below, so the fetch and the attribution can never fall
 * out of step with each other.
 *
 * `member`, `venue`, `message` and every directory subject have no community
 * at all and are dropped rather than guessed at.
 */
export const COMMUNITY_SCOPED_SUBJECT_TYPES = [
  ReportSubjectType.Post,
  ReportSubjectType.Reply,
  // TS-13: one photograph in the album of a gathering a community hosts. Its
  // reason set leads with `outing` and `doxxing`, the two codes in the
  // emergency band, so a community's queue that could not count these was
  // blind to the reports it exists to answer fastest.
  ReportSubjectType.EventPhoto,
  ReportSubjectType.Community,
] as const;

/** One of {@link COMMUNITY_SCOPED_SUBJECT_TYPES}. */
export type CommunityScopedSubjectType =
  (typeof COMMUNITY_SCOPED_SUBJECT_TYPES)[number];

/**
 * The community-scoped subject types whose `subjectId` is a CONTENT ID, so
 * they are attributed through `communityIdBySubjectId` rather than by slug.
 *
 * Adding a value to {@link COMMUNITY_SCOPED_SUBJECT_TYPES} widens this type
 * too, which is what turns the silent drop described below into a compile
 * error: `AdminCommunitiesService.loadReportScope` builds its lookups as a
 * `Record<CommunityContentSubjectType, ...>`, and a `Record` missing a member
 * of its key union does not typecheck. A new content subject type therefore
 * cannot reach the fetch without also getting a loader.
 */
export type CommunityContentSubjectType = Exclude<
  CommunityScopedSubjectType,
  ReportSubjectType.Community
>;

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
 * - `post`, `reply` and `event_photo` reports: `subjectId` is a **content id**
 *   (a post id, a reply id, or a gathering photograph's id — the three live in
 *   separate tables but share this one lookup), resolved through
 *   `communityIdBySubjectId`.
 * - `member`, `venue`, and `message` reports have no associated community at
 *   all and are dropped rather than guessed at.
 *
 * CONTRACT FOR CALLERS (`AdminCommunitiesService.loadReportScope`, which
 * builds these maps with batched queries): `communityIdBySubjectId` MUST be
 * keyed by EVERY {@link CommunityContentSubjectType}, each id mapped to the
 * community that content belongs to. A map built from only some of the
 * content tables silently drops the rest here: those reports simply are not
 * found in the map and are excluded from every community's totals, with no
 * error raised.
 *
 * That silence is why {@link CommunityContentSubjectType} exists. The caller
 * assembles its per-table loaders as a `Record` keyed by that union, so
 * widening {@link COMMUNITY_SCOPED_SUBJECT_TYPES} without adding the matching
 * loader fails to compile instead of quietly under-counting a community's
 * queue.
 *
 * @param reports the reports to attribute, unfiltered.
 * @param communityIdBySubjectId post, reply or photo id → owning community id.
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
