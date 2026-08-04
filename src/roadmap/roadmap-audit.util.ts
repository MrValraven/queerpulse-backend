import { EntityManager, Repository } from 'typeorm';
import { RoadmapAuditLog } from './entities/roadmap-audit-log.entity';

/** One row to append to `roadmap_audit_log`. `actorId: null` is the
 * system-attributed case (see `RoadmapAuditLog.actorId`'s doc) — `actorLabel`
 * still carries a display name either way. */
export interface AuditLogEntry {
  actorId: string | null;
  actorLabel: string;
  action: string;
}

/**
 * Inserts one `RoadmapAuditLog` row backing every admin mutation's audit
 * trail (`GET /roadmap/admin/audit` + its CSV export).
 *
 * Pure write — this helper does NOT swallow errors. Best-effort semantics
 * ("an audit-log failure must never fail the mutation it documents") are the
 * CALLER's responsibility: wrap the call in try/catch at the call site (see
 * `RoadmapAdminService.audit`), same posture as
 * `NotificationsService.announce`'s doc on why a side-effect write must not
 * be allowed to fail the primary one.
 *
 * Accepts either an injected `Repository<RoadmapAuditLog>` or an
 * `EntityManager` — pass the manager from inside a caller's
 * `repo.manager.transaction(async (manager) => …)` so the audit row commits
 * (or rolls back) atomically with the mutation it documents; pass the plain
 * repository for a standalone, non-transactional write.
 */
export async function logAudit(
  repoOrManager: Repository<RoadmapAuditLog> | EntityManager,
  entry: AuditLogEntry,
): Promise<RoadmapAuditLog> {
  // Duck-typed rather than `instanceof EntityManager`: an `EntityManager`
  // exposes `getRepository`, a `Repository` doesn't — and unlike `instanceof`,
  // this holds for the plain manager/repo test doubles unit specs construct
  // (see `roadmap-admin.service.spec.ts`), which are never real driver
  // instances.
  const repo: Repository<RoadmapAuditLog> =
    'getRepository' in repoOrManager
      ? repoOrManager.getRepository(RoadmapAuditLog)
      : repoOrManager;
  return repo.save(repo.create(entry));
}
