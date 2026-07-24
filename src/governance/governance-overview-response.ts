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
  };
}
