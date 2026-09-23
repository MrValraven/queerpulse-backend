import type { Repository, SelectQueryBuilder } from 'typeorm';
import type { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import {
  mailboxThreadPredicate,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';

/**
 * A `NOT EXISTS` SQL fragment (message alias `m`) that is TRUE only when the
 * viewer bound to `:hiddenForUserId` has not "deleted for me" (PRD-227) this
 * message. The one copy of this rule for every message-counting and preview
 * builder, `MessagingCoreService` included.
 */
export function notHiddenForViewerMessagePredicate(): string {
  return `NOT EXISTS (
      SELECT 1 FROM "message_hides" "mh"
      WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :hiddenForUserId
    )`;
}

/**
 * A fragment (message alias `m`, seat alias `p`) that is TRUE unless the
 * message was sent AS the seat's own identity. On a shared mailbox, a
 * colleague's reply sent as the business is the business speaking, so it is
 * already read for every staff seat of that business; the customer's
 * message stays unread until a staff member reads it. A null
 * `sender_identity_id` (a personal message) is distinct from every seat
 * identity, so it follows the other rules alone. On a profile seat this
 * matches only the member's own sends, which `m.sender_id != :userId`
 * already leaves out, because a member has exactly one profile identity.
 * Every unread formula composes it: this scope,
 * `MessagingCoreService.unreadCountsByConversation` and
 * `MessagingCoreService.hasUnreadMentionByConversation`.
 */
export const NOT_SENT_AS_SEAT_IDENTITY_PREDICATE =
  'm.sender_identity_id IS DISTINCT FROM p.identity_id';

/**
 * Narrows `queryBuilder`, a builder over `conversation_participants` aliased
 * `p`, to the seats of `userId` that count as UNREAD. This is THE single
 * "unread thread" definition (PRD-341), shared by the nav DM badge
 * (`MessagingCoreService.unreadConversationCount`) and the mailbox switcher
 * (`countUnreadConversationsByIdentity`), so a mailbox's number is exactly
 * the badge restricted to the seats that speak for that mailbox. The caller
 * adds only its own select and grouping on top.
 *
 * A seat counts if it is NOT archived AND EITHER has a genuinely unread
 * message (the same per-message rules as
 * `MessagingCoreService.unreadCountsByConversation`: not the caller's own,
 * never one sent as the seat's own identity
 * (`NOT_SENT_AS_SEAT_IDENTITY_PREDICATE`), past their
 * `last_read_at`/`cleared_at`/`left_at` watermarks, never a moderated,
 * self-hidden or deleted row) OR the caller explicitly
 * `markedUnreadAt` it (PRD-225) with nothing new to actually read.
 *
 * A blocked DM does not appear in the inbox (`listConversations` drops it),
 * so it counts nowhere either: otherwise the number permanently outruns the
 * list beneath it, on a thread the member has no UI path to open and clear.
 * Scoped to DIRECT, non-official threads for the same reason every other
 * block gate is: a block between two members does not dissolve a group, and
 * nobody is blocked out of the platform's own official thread (BE-MSG-08).
 * Task 13c: a business mailbox thread is exempt from that person-block rule,
 * matching `listConversations`, and follows the mailbox exclusion below.
 *
 * Task 13c fix round 1: a STAFF member blocked either way with a mailbox
 * thread's customer is left out of that thread everywhere. Task 14a: a
 * departed staff member too. Task 14: both sides of a thread whose customer
 * blocked the business too. All three through
 * `seatExcludedFromMailboxPredicate`, so a count never points at a thread
 * that refuses to open.
 */
export function applyUnreadConversationScope(
  queryBuilder: SelectQueryBuilder<ConversationParticipant>,
  userId: string,
): SelectQueryBuilder<ConversationParticipant> {
  return queryBuilder
    .innerJoin(Conversation, 'c', 'c.id = p.conversation_id')
    .where('p.user_id = :userId', { userId })
    .andWhere('p.archived_at IS NULL')
    .andWhere(
      `(
          p.marked_unread_at IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM "messages" m
            WHERE m.conversation_id = p.conversation_id
              AND m.deleted_at IS NULL
              AND m.sender_id != :userId
              AND ${NOT_SENT_AS_SEAT_IDENTITY_PREDICATE}
              AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
              AND (p.cleared_at IS NULL OR m.created_at > p.cleared_at)
              AND (p.left_at IS NULL OR m.created_at <= p.left_at)
              AND ${notModeratedMessagePredicate('m')}
              AND ${notHiddenForViewerMessagePredicate()}
          )
        )`,
    )
    .andWhere(
      `NOT EXISTS (
          SELECT 1 FROM "conversation_participants" "__unread_other"
          JOIN "blocks" "__unread_block"
            ON ("__unread_block"."blocker_id" = :userId AND "__unread_block"."blocked_id" = "__unread_other"."user_id")
            OR ("__unread_block"."blocked_id" = :userId AND "__unread_block"."blocker_id" = "__unread_other"."user_id")
          WHERE "__unread_other"."conversation_id" = p.conversation_id
            AND "__unread_other"."user_id" != :userId
            AND c."kind" != :unreadGroupKind
            AND c."is_official" = false
            AND NOT ${mailboxThreadPredicate('p.conversation_id')}
        )`,
      { unreadGroupKind: ConversationKind.Group },
    )
    .andWhere(
      `NOT ${seatExcludedFromMailboxPredicate('p.conversation_id', ':userId')}`,
    )
    .setParameter('messageSubjectType', MESSAGE_SUBJECT_TYPE)
    .setParameter('hiddenForUserId', userId);
}

/**
 * Task 15: how many unread threads each of `identityIds` holds for `userId`,
 * read from that member's own seats speaking for each identity, in ONE
 * grouped query however many identities are asked about. The seats are
 * narrowed by `applyUnreadConversationScope`, the badge's own definition, so
 * the per-mailbox numbers sum to the nav badge for the identities asked
 * about. An identity with no unread seat is absent from the map; a caller
 * reads a missing entry as zero.
 */
export async function countUnreadConversationsByIdentity(
  participants: Pick<Repository<ConversationParticipant>, 'createQueryBuilder'>,
  userId: string,
  identityIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  const uniqueIdentityIds = [...new Set(identityIds)];
  if (uniqueIdentityIds.length === 0) {
    return new Map();
  }
  const rows = await applyUnreadConversationScope(
    participants
      .createQueryBuilder('p')
      .select('p.identity_id', 'identityId')
      .addSelect('COUNT(DISTINCT p.conversation_id)', 'count'),
    userId,
  )
    .andWhere('p.identity_id IN (:...mailboxIdentityIds)', {
      mailboxIdentityIds: uniqueIdentityIds,
    })
    .groupBy('p.identity_id')
    .getRawMany<{ identityId: string; count: string }>();
  return new Map(rows.map((row) => [row.identityId, Number(row.count)]));
}
