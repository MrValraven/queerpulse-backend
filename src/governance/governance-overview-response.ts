import {
  GovernanceOverview,
  OverviewCouncilSeat,
  OverviewDecision,
  OverviewHealthStat,
  OverviewModerationStep,
  OverviewPrinciple,
} from './entities/governance-overview.entity';

export interface GovernanceOverviewResponseDTO {
  health: OverviewHealthStat[];
  moderationSteps: OverviewModerationStep[];
  council: OverviewCouncilSeat[];
  principles: OverviewPrinciple[];
  decisions: OverviewDecision[];
  /** ISO-8601 timestamp of the last publish (P3-7), or `null` if never
   *  published. Lets the public governance page render a "last published" line. */
  publishedAt: string | null;
}

/** Response for `POST /admin/governance/publish` (P3-7). */
export interface GovernancePublishResponseDTO {
  publishedAt: string;
}

/**
 * Maps the singleton entity → response by hand (no global serializer; per repo
 * convention every endpoint maps explicitly or leaks columns). Drops `id` and
 * `updatedAt` — the frontend needs neither.
 */
export function toGovernanceOverviewResponse(
  overview: GovernanceOverview,
): GovernanceOverviewResponseDTO {
  return {
    health: overview.health,
    moderationSteps: overview.moderationSteps,
    council: overview.council,
    principles: overview.principles,
    decisions: overview.decisions,
    publishedAt: overview.publishedAt
      ? overview.publishedAt.toISOString()
      : null,
  };
}
