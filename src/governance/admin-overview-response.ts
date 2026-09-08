import { MemberRef } from '../common/member-ref';
import {
  GovernanceOverview,
  OverviewAuthoredText,
  OverviewDecision,
  OverviewHealthStat,
  OverviewModerationStep,
  OverviewPrinciple,
} from './entities/governance-overview.entity';
import {
  GovernanceOverviewChange,
  OverviewSection,
} from './entities/governance-overview-change.entity';

/**
 * One advisory-council seat as the EDITOR sees it. The public shape
 * (`CouncilSeatResponseDTO`) carries a resolved `member` and nothing else; this
 * one keeps the stored `memberId` too, because the editor round-trips seats
 * straight back into `PATCH /admin/governance/overview` and that is the field
 * the write side takes.
 *
 * `member` is null when the seat-holder no longer resolves — a deleted account,
 * or a user row with no profile. The public page drops such a seat rather than
 * render a hole; here it survives, precisely so an admin can see WHY a seat
 * stopped appearing and remove or reassign it, instead of a row silently
 * vanishing from a page nobody is watching.
 */
export interface AdminCouncilSeatDTO {
  memberId: string;
  member: MemberRef | null;
  roleKey?: string;
  role?: OverviewAuthoredText;
  tint: 'jade' | 'violet' | 'plum';
}

/** Who last edited a section, and when — `null`/`null` when it has never
 *  been edited since this audit trail started. */
export interface AdminOverviewSectionMeta {
  editor: MemberRef | null;
  editedAt: string | null;
}

// Backs `GET /admin/governance/overview` — the admin Policy tab. Same content
// as the public `GET /governance/overview`, plus per-section "last edited by
// X on Y" metadata computed from `governance_overview_changes`.
export interface AdminOverviewResponseDTO {
  health: OverviewHealthStat[];
  moderationSteps: OverviewModerationStep[];
  council: AdminCouncilSeatDTO[];
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
  council: AdminCouncilSeatDTO[],
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
    council,
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
