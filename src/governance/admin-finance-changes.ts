import { MemberRef } from '../common/member-ref';
import { GovernanceFinanceChange } from './entities/governance-finance-change.entity';

// Backs `GET /admin/governance/finances/changes` — the per-field audit trail
// behind the Finances tab's "last edited" badges. Each row is enriched with
// the actor's display ref (never a raw uuid), so the history reads "Ana Costa
// changed MRR from €23,150 to €24,000".
export interface AdminFinanceChangeDTO {
  id: string;
  actor: MemberRef | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  note: string | null;
  createdAt: string;
}

export function toAdminFinanceChange(
  change: GovernanceFinanceChange,
  actor: MemberRef | null,
): AdminFinanceChangeDTO {
  return {
    id: change.id,
    actor,
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
    note: change.note,
    createdAt: change.createdAt.toISOString(),
  };
}
