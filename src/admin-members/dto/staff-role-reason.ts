/**
 * The reason an admin gives when granting or revoking a staff role (PRD-288).
 *
 * ## Why a reason at all
 *
 * A staff-role grant is what gates a moderator's queues. Granting or revoking
 * one was a bare checkbox toggle: no confirmation, and nothing recorded about
 * why. The `mod_audit_logs` row written by `grantStaffRole` / `revokeStaffRole`
 * carried the role id in `note` and nothing else, so the audit feed could say
 * "Ana granted magazine_writer to Rui" and could never say why. Every
 * neighbouring lever on the same drawer (a role change, a suspension, an
 * invite revocation) already asks.
 */

/**
 * Floor for the reason, in characters, after trimming.
 *
 * Ten rather than the twenty a member-facing moderation note takes
 * (`moderation/dto/member-facing-note.ts`), and the difference is deliberate:
 * this text is read by other admins in the audit feed, never by the member it
 * names, and nobody has to build an appeal out of it. Real reasons here are
 * short and complete on their own ("covering triage", "joined the housing
 * team"). Ten characters is about two words, which rules out "x", "." and "ok"
 * while never getting in the way of one of those.
 */
export const MIN_STAFF_ROLE_REASON_LENGTH = 10;

/**
 * Ceiling. Short by the standards of this codebase's 2000-character notes,
 * because the audit feed renders `note` inline in a row and the reason shares
 * that one column with the role id. A staff-role change that needs an essay
 * needs a conversation somewhere else first.
 */
export const MAX_STAFF_ROLE_REASON_LENGTH = 500;

export const STAFF_ROLE_REASON_MESSAGE =
  'Say why this staff role is changing hands. It is recorded in the audit ' +
  `trail and read by other admins, so write at least ${MIN_STAFF_ROLE_REASON_LENGTH} characters.`;

/** Trims a string value before validation, so a reason of spaces fails. */
export const trimmedReason = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The `mod_audit_logs.note` written for a staff-role grant or revoke.
 *
 * `<role id>: <reason>`, role first, so the shape stays readable next to the
 * rows written before this existed (which are the bare role id) and the audit
 * feed's `note ILIKE` search still finds a row by role name. Falls back to the
 * bare role id when no reason is supplied, which is only ever an internal
 * caller: the HTTP surface requires one.
 */
export function staffRoleAuditNote(role: string, reason?: string): string {
  const trimmed = reason?.trim();
  return trimmed ? `${role}: ${trimmed}` : role;
}
