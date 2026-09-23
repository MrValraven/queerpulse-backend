import { FindOperator, Raw } from 'typeorm';
import { seatExcludedFromMailboxByStoredConversationIdPredicate } from '../messaging/mailbox-seats';

/** The bound parameter carrying the reader's user id into the predicate. */
export const MAILBOX_SEAT_READER_PARAMETER = 'mailboxSeatReaderUserId';

/**
 * Task 13g: the `payload` condition every read of a member's own
 * notification rows applies, so a row that names a business mailbox thread
 * the member is now blocked out of stays hidden from them. A mention written
 * inside that thread before the block carries a 140 character excerpt of it
 * and names its author, so the bell, the unread badge, the mentions inbox
 * and the data export all leave it out while the block stands, and all show
 * it again once the block is lifted. Nothing is deleted.
 *
 * Task 14a: a staff member who has left the business loses these rows the
 * same way, for as long as they stay away, and gets them back if they are
 * seated again.
 *
 * Task 14: once a customer blocks a business, the customer and every staff
 * member of it lose the rows naming a thread between them, and get them
 * back when the block is lifted.
 *
 * The rule itself is `seatExcludedFromMailboxPredicate`, reached through
 * `seatExcludedFromMailboxByStoredConversationIdPredicate`, so a row is
 * hidden exactly when `readerUserId`'s own seat in that thread is a seat
 * the block rules or the departed-staff rule exclude. A colleague's rows, a
 * group leaver's rows, the rows of a customer who blocked no business, and
 * every row that names no conversation are untouched.
 *
 * Used as `where: { userId, payload: visibleThroughMailboxSeatRules(userId) }`.
 * TypeORM hands the generator the payload column's own path.
 */
export function visibleThroughMailboxSeatRules(
  readerUserId: string,
): FindOperator<Record<string, unknown>> {
  return Raw(
    (payloadColumn: string) =>
      `NOT ${seatExcludedFromMailboxByStoredConversationIdPredicate(
        `(${payloadColumn} ->> 'conversationId')`,
        `:${MAILBOX_SEAT_READER_PARAMETER}`,
      )}`,
    { [MAILBOX_SEAT_READER_PARAMETER]: readerUserId },
  ) as FindOperator<Record<string, unknown>>;
}
