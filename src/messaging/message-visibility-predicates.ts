/**
 * SQL fragments that decide whether a message row is visible, shared by every
 * query builder that lists, counts or searches messages. Before this file each
 * service carried its own verbatim copy of the takedown predicate, and a copy
 * that drifts from the others shows a taken-down message on one surface only.
 */

import { ConversationKind } from './entities/conversation.entity';
import { MessageKind } from './entities/message.entity';

/** `content_moderation.subject_type` for a message takedown row. */
export const MESSAGE_SUBJECT_TYPE = 'message';

/**
 * A `NOT EXISTS` fragment that is TRUE only when no moderator has hidden or
 * removed the message aliased `messageAlias`. The caller binds
 * `:messageSubjectType` to {@link MESSAGE_SUBJECT_TYPE}.
 */
export function notModeratedMessagePredicate(messageAlias: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM "content_moderation" "cm"
      WHERE "cm"."subject_type" = :messageSubjectType
        AND "cm"."subject_id" = ${messageAlias}.id::text
        AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
    )`;
}

/**
 * ENG-401: the `leftAt` read ceiling, for a builder that already joins the
 * viewer's own seat as `participantAlias`. TRUE when the seat is still active
 * or the message (its creation column spliced verbatim as
 * `messageCreatedAtColumn`) was created at or before the moment the seat left
 * or was removed. A member who left a group reads only what was posted while
 * they belonged to it, so every surface that shows or counts a message for
 * them (history, inbox preview and sort, unread counts, the nav badge,
 * attachment downloads) applies this one rule. `MessagesService.getMessages`
 * applies the same ceiling from the loaded seat as `m.created_at <= :leftAt`.
 */
export function withinLeftAtCeilingPredicate(
  messageCreatedAtColumn: string,
  participantAlias: string,
): string {
  return `(${participantAlias}.left_at IS NULL OR ${messageCreatedAtColumn} <= ${participantAlias}.left_at)`;
}

/**
 * ENG-401: {@link withinLeftAtCeilingPredicate} for a builder with no seat
 * join (the inbox preview's `DISTINCT ON` pass). A correlated `NOT EXISTS`
 * over the viewer's own seat, answered by the unique
 * `(conversation_id, user_id)` index, so it stays one set-based query for a
 * whole inbox page. A viewer with no seat in the conversation has no ceiling
 * to apply. `viewerParameter` is the already-prefixed bound parameter that
 * holds the viewer's user id (e.g. `':hiddenForUserId'`).
 */
export function notPastViewerLeftAtPredicate(
  messageAlias: string,
  viewerParameter: string,
): string {
  return `NOT EXISTS (
      SELECT 1 FROM "conversation_participants" "left_seat"
      WHERE "left_seat"."conversation_id" = ${messageAlias}.conversation_id
        AND "left_seat"."user_id" = ${viewerParameter}
        AND "left_seat"."left_at" IS NOT NULL
        AND ${messageAlias}.created_at > "left_seat"."left_at"
    )`;
}

/**
 * ENG-402: PRD-354's group block filter as a composable fragment. TRUE unless
 * the message aliased `messageAlias` is a member message in a GROUP
 * conversation whose sender is blocked either way with the viewer bound to
 * `viewerParameter` (already prefixed, e.g. `':userId'`). This is the rule
 * `MessagesService.getMessages` applies to group history through
 * `BlockFilterService.excludeBlocked`, restated as one fragment so the inbox
 * preview, the list's sort key, the per-thread unread count, the mention
 * flag and the nav badge hide exactly the messages the thread hides:
 *
 *  - a group's own system pills stay visible whoever their actor is, since a
 *    pill reports what happened in the group;
 *  - a direct or official thread is untouched here, because a block already
 *    removes a blocked direct thread from the inbox and the badge whole;
 *  - an erased sender (`sender_id` NULL) matches no block row and stays.
 *
 * Fix round 1 (review finding 1): the viewer's blocked set is an
 * UNCORRELATED `ARRAY(...)` subquery, so Postgres evaluates it once per
 * query as an InitPlan. A correlated `NOT EXISTS` over `blocks` inside this
 * `OR` could not become an anti-join and ran once per message row, which the
 * inbox sort key pays across every message of every conversation. The two
 * halves of the `UNION ALL` read the `(blocker_id, blocked_id)` pair index
 * and the `blocked_id` index. The conversation kind arm is the only
 * correlated part left, a primary key probe that matters only for a message
 * whose sender is in the blocked set.
 */
export function notFromBlockedGroupMemberPredicate(
  messageAlias: string,
  viewerParameter: string,
): string {
  return `(
      ${messageAlias}.kind = '${MessageKind.System}'
      OR ${messageAlias}.sender_id IS NULL
      OR ${messageAlias}.sender_id <> ALL (ARRAY(
        SELECT "blocked_by_viewer"."blocked_id" FROM "blocks" "blocked_by_viewer"
          WHERE "blocked_by_viewer"."blocker_id" = ${viewerParameter}
        UNION ALL
        SELECT "blocker_of_viewer"."blocker_id" FROM "blocks" "blocker_of_viewer"
          WHERE "blocker_of_viewer"."blocked_id" = ${viewerParameter}
      ))
      OR NOT EXISTS (
        SELECT 1 FROM "conversations" "group_block_conversation"
        WHERE "group_block_conversation"."id" = ${messageAlias}.conversation_id
          AND "group_block_conversation"."kind" = '${ConversationKind.Group}'
      )
    )`;
}
