/**
 * ENG-245: the audit contract for a staff "delete for everyone".
 *
 * A moderator or admin who is a participant could tombstone any member's
 * message with no trail, unlike hide/remove through the report path. Every such
 * delete now writes one `mod_audit_logs` row with this action, in the same
 * transaction as the tombstone, so the global audit feed shows who removed
 * whose words, where, and why.
 */
export const MESSAGE_DELETED_BY_STAFF_AUDIT_ACTION = 'message_deleted_by_staff';

/** A staff delete named a `reportId` that is not a report about this exact
 *  message. Refused rather than recorded, so an audit row never links a
 *  takedown to an unrelated case. */
export const REPORT_SUBJECT_MISMATCH_CODE = 'REPORT_SUBJECT_MISMATCH';

/** The audit row's note: the message and conversation ids first, so the row
 *  is findable by either through the feed's note search, then the staff
 *  member's own words when they gave any. */
export function staffMessageDeletionAuditNote(
  messageId: string,
  conversationId: string,
  staffNote: string | undefined,
): string {
  const facts = `Deleted message ${messageId} in conversation ${conversationId}`;
  const trimmedNote = staffNote?.trim();
  return trimmedNote ? `${facts}. ${trimmedNote}` : facts;
}
