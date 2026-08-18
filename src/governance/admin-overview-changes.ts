import { MemberRef } from '../common/member-ref';
import { GovernanceOverviewChange } from './entities/governance-overview-change.entity';

// Backs `GET /governance/admin/overview/changes` — the per-section audit
// trail. Each row is enriched with the actor's display ref (never a raw
// uuid).
export interface AdminOverviewChangeDTO {
  id: string;
  section: string;
  actor: MemberRef | null;
  before: unknown;
  after: unknown;
  note: string | null;
  createdAt: string;
}

export function toAdminOverviewChange(
  change: GovernanceOverviewChange,
  actor: MemberRef | null,
): AdminOverviewChangeDTO {
  return {
    id: change.id,
    section: change.section,
    actor,
    before: change.before,
    after: change.after,
    note: change.note,
    createdAt: change.createdAt.toISOString(),
  };
}
