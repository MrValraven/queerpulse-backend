import type { Repository } from 'typeorm';
import type { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';

/** The leads actions that land in the shared moderation trail. */
export const LEAD_AUDIT_ACTIONS = {
  personaLinked: 'lead_persona_linked',
  personaUnlinked: 'lead_persona_unlinked',
  deleted: 'lead_deleted',
} as const;

export type LeadAuditAction =
  (typeof LEAD_AUDIT_ACTIONS)[keyof typeof LEAD_AUDIT_ACTIONS];

/** One leads action to record. Ids only: the trail never names a lead. */
export interface LeadAuditEntry {
  actorId: string;
  action: LeadAuditAction;
  leadId: string;
  /** The persona linked, the persona unlinked, or the persona the deleted
   *  lead was linked to; null when a deleted lead had none. */
  subprofileId: string | null;
}

/**
 * One immutable row in the shared moderation trail for a persona link, a
 * persona unlink or a lead delete, so staff work on a lead that touches a
 * member's persona shows in the same audit feed as every other action.
 *
 * The note is `lead:<leadId>` plus ` persona:<subprofileId>` when a persona
 * is involved, both ids lowercase. No name, email, phone, link, note text or
 * stage goes into the row, and `targetUserId` and `targetName` stay null
 * because the row names no member. `reportId` stays null because a lead
 * action answers no report. A persona swap in one PATCH is two rows:
 * unlinked (old), then linked (new).
 */
export function buildLeadAuditRow(entry: LeadAuditEntry): Partial<ModAuditLog> {
  const leadPart = `lead:${entry.leadId.toLowerCase()}`;
  const note =
    entry.subprofileId === null
      ? leadPart
      : `${leadPart} persona:${entry.subprofileId.toLowerCase()}`;
  return {
    reportId: null,
    actorId: entry.actorId,
    action: entry.action,
    targetUserId: null,
    targetName: null,
    reasonCode: null,
    duration: null,
    note,
  };
}

/** Saves the row `buildLeadAuditRow` builds through the given repository
 *  (pass the transaction's repository to keep it in the same transaction). */
export async function writeLeadAudit(
  repository: Repository<ModAuditLog>,
  entry: LeadAuditEntry,
): Promise<void> {
  await repository.save(repository.create(buildLeadAuditRow(entry)));
}
