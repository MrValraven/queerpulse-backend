import { MemberRef } from '../common/member-ref';
import {
  GovernanceOverview,
  OverviewCouncilSeat,
  OverviewDecision,
  OverviewHealthStat,
  OverviewModerationStep,
  OverviewPrinciple,
} from './entities/governance-overview.entity';
import {
  GovernanceOverviewChange,
  OverviewSection,
} from './entities/governance-overview-change.entity';

/** Who last edited a section, and when — `null`/`null` when it has never
 *  been edited since this audit trail started. */
export interface AdminOverviewSectionMeta {
  editor: MemberRef | null;
  editedAt: string | null;
}

// Backs `GET /governance/admin/overview` — the admin Policy tab. Same content
// as the public `GET /governance/overview`, plus per-section "last edited by
// X on Y" metadata computed from `governance_overview_changes`.
export interface AdminOverviewResponseDTO {
  health: OverviewHealthStat[];
  moderationSteps: OverviewModerationStep[];
  council: OverviewCouncilSeat[];
  principles: OverviewPrinciple[];
  decisions: OverviewDecision[];
  meta: Record<OverviewSection, AdminOverviewSectionMeta>;
}

/**
 * Maps the singleton entity + the latest change per section → the admin
 * response. `latestChangeBySection` and `editorsByActorId` are precomputed by
 * the caller (`GovernanceOverviewService.getAdminOverview`) so this stays a
 * pure, easily-testable mapping function.
 */
export function toAdminOverviewResponse(
  overview: GovernanceOverview,
  latestChangeBySection: ReadonlyMap<OverviewSection, GovernanceOverviewChange>,
  editorsByActorId: ReadonlyMap<string, MemberRef>,
): AdminOverviewResponseDTO {
  const metaFor = (section: OverviewSection): AdminOverviewSectionMeta => {
    const change = latestChangeBySection.get(section);
    if (!change) return { editor: null, editedAt: null };
    return {
      editor: change.actorId
        ? (editorsByActorId.get(change.actorId) ?? null)
        : null,
      editedAt: change.createdAt.toISOString(),
    };
  };

  return {
    health: overview.health,
    moderationSteps: overview.moderationSteps,
    council: overview.council,
    principles: overview.principles,
    decisions: overview.decisions,
    meta: {
      [OverviewSection.Health]: metaFor(OverviewSection.Health),
      [OverviewSection.ModerationSteps]: metaFor(
        OverviewSection.ModerationSteps,
      ),
      [OverviewSection.Council]: metaFor(OverviewSection.Council),
      [OverviewSection.Principles]: metaFor(OverviewSection.Principles),
      [OverviewSection.Decisions]: metaFor(OverviewSection.Decisions),
    },
  };
}
