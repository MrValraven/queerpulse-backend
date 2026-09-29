import { EntityManager } from 'typeorm';
import { buildReplyTo, MessageResponse } from './message-response';

/**
 * PRD-400 (owner decision 2026-09-29, WhatsApp model): a person who takes a
 * BRAND-NEW seat in an existing group (added by a member, an accepted
 * invite, a link join, a Go together late joiner) reads the group from the
 * moment they joined. Their seat is written with `clearedAt` and
 * `historyFloorAt` both set to this instant:
 *  - `clearedAt` is the floor every history read already applies (the
 *    message list, the around/jump window, reconnect sync, search, the
 *    media gallery, pins, stars, reactor lists, the inbox preview and the
 *    unread count), so none of them needs a change;
 *  - `historyFloorAt` marks the seat's JOIN floor, which a later personal
 *    "clear chat" never moves. Reply quotes read it through
 *    `groupJoinHistoryFloorCoversPredicate`, so a post-join reply quoting a
 *    pre-join message renders the unavailable quote with no snippet,
 *    thumbnail or file name.
 * Seats created together with the group (its creator and the members seated
 * at creation) take no floor: their history starts with the group anyway.
 *
 * The instant is the transaction's own `now()` truncated to the millisecond,
 * minus one millisecond. Every write of one join (the seat and its
 * `member_added` or `member_joined` pill) shares that transaction's `now()`
 * as its `created_at`, so the pill sits strictly after the floor and the
 * joiner sees the pill announcing their own arrival, which also keeps the
 * group in their inbox (`listConversations` hides a seat whose every message
 * sits at or before `cleared_at`). Whole milliseconds load back through
 * node-pg unchanged, so an in-memory comparison and a SQL comparison of the
 * floor agree. The price is that a message stamped in the two milliseconds
 * before the join stays visible.
 */
export async function readGroupJoinHistoryFloor(
  manager: EntityManager,
): Promise<Date> {
  const [row] = await manager.query<{ floorInstant: Date }[]>(
    `SELECT date_trunc('milliseconds', now()) - interval '1 millisecond' AS "floorInstant"`,
  );
  if (!row) {
    throw new Error('The database returned no clock reading');
  }
  return row.floorInstant;
}

/**
 * PRD-400: SQL that holds when a row created at `createdAtExpression` sits at
 * or before the JOIN floor of the GROUP seat `seatAlias`
 * (`conversation_participants`, read through its `history_floor_at` and
 * `conversation_id`). Only `readGroupJoinHistoryFloor`'s callers write
 * `history_floor_at` on a group seat, so a member's own "clear chat" never
 * matches and keeps its quotes, as before. The mailbox staff floor
 * (`mailboxStaffHistoryFloorCoversPredicate`) covers direct threads alone;
 * the two never overlap. The subquery alias is lowercase and quoted at every
 * reference. Compose it as `NOT ...` to keep only what the seat may see.
 */
export function groupJoinHistoryFloorCoversPredicate(
  createdAtExpression: string,
  seatAlias: string,
): string {
  return `(${seatAlias}.history_floor_at IS NOT NULL
    AND ${createdAtExpression} <= ${seatAlias}.history_floor_at
    AND EXISTS (
      SELECT 1 FROM "conversations" "join_floor_group"
      WHERE "join_floor_group"."id" = ${seatAlias}.conversation_id
        AND "join_floor_group"."kind" = 'group'
    ))`;
}

/**
 * PRD-400: `response` as a member whose join floor covers its reply parent
 * reads it. The quote becomes the missing-parent quote `buildReplyTo` renders
 * when the parent is not in its map (`deleted`, no snippet, sender name,
 * thumbnail or file name, the generic `user` kind), which is exactly what
 * `MessagingCoreService.toMessageResponses` serves that member over HTTP.
 * A message that quotes nothing is returned as it came.
 */
export function withJoinFlooredReplyQuote(
  response: MessageResponse,
): MessageResponse {
  if (!response.replyTo) {
    return response;
  }
  return {
    ...response,
    replyTo: buildReplyTo(response.replyTo.id, new Map(), new Map()),
  };
}
