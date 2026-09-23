import {
  mailboxThreadPredicate,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 15 fix round 1: a snapshot of the nav badge's query
 * (`MessagingCoreService.unreadConversationCount`), call by call, so any edit
 * to the shared `applyUnreadConversationScope` shows up here as a deliberate
 * change to this literal. The badge and the per-mailbox counts both read that
 * scope, so a test comparing the two cannot see an edit that moves both.
 *
 * Fix round 1 ruling, a deliberate update of this literal: a message sent as
 * the seat's own identity is never unread for that seat
 * (`m.sender_identity_id IS DISTINCT FROM p.identity_id`). For a profile seat
 * the badge's result is unchanged, because a member's one profile identity is
 * carried only by that member's own sends, which `m.sender_id != :userId`
 * already leaves out.
 *
 * The mailbox predicates are owned by `mailbox-seats.ts` and pinned by its own
 * specs, so they are composed here from the same functions.
 */

const VIEWER_ID = 'viewer';

function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

async function recordBadgeCalls(): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const query = {} as Record<string, jest.Mock>;
  for (const method of [
    'select',
    'innerJoin',
    'where',
    'andWhere',
    'setParameter',
  ]) {
    query[method] = jest.fn((...parameters: unknown[]) => {
      calls.push([
        method,
        ...parameters.map((parameter) => {
          if (typeof parameter === 'string') {
            return normaliseSql(parameter);
          }
          if (typeof parameter === 'function') {
            return (parameter as { name: string }).name;
          }
          return parameter;
        }),
      ]);
      return query;
    });
  }
  query.getRawOne = jest.fn().mockResolvedValue({ count: '0' });
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, {
    participants: { createQueryBuilder: jest.fn(() => query) },
  });
  await core.unreadConversationCount(VIEWER_ID);
  return calls;
}

const UNREAD_THREAD_FRAGMENT = normaliseSql(`( p.marked_unread_at IS NOT NULL
  OR EXISTS ( SELECT 1 FROM "messages" m
    WHERE m.conversation_id = p.conversation_id
      AND m.deleted_at IS NULL
      AND m.sender_id != :userId
      AND m.sender_identity_id IS DISTINCT FROM p.identity_id
      AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
      AND (p.cleared_at IS NULL OR m.created_at > p.cleared_at)
      AND (p.left_at IS NULL OR m.created_at <= p.left_at)
      AND NOT EXISTS ( SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :messageSubjectType
          AND "cm"."subject_id" = m.id::text
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL) )
      AND NOT EXISTS ( SELECT 1 FROM "message_hides" "mh"
        WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :hiddenForUserId ) ) )`);

const PERSON_BLOCK_FRAGMENT = normaliseSql(`NOT EXISTS (
  SELECT 1 FROM "conversation_participants" "__unread_other"
  JOIN "blocks" "__unread_block"
    ON ("__unread_block"."blocker_id" = :userId AND "__unread_block"."blocked_id" = "__unread_other"."user_id")
    OR ("__unread_block"."blocked_id" = :userId AND "__unread_block"."blocker_id" = "__unread_other"."user_id")
  WHERE "__unread_other"."conversation_id" = p.conversation_id
    AND "__unread_other"."user_id" != :userId
    AND c."kind" != :unreadGroupKind
    AND c."is_official" = false
    AND NOT ${mailboxThreadPredicate('p.conversation_id')} )`);

describe('the nav badge query (snapshot)', () => {
  it('runs exactly these calls, in this order', async () => {
    await expect(recordBadgeCalls()).resolves.toEqual([
      ['select', 'COUNT(DISTINCT p.conversation_id)', 'count'],
      ['innerJoin', 'Conversation', 'c', 'c.id = p.conversation_id'],
      ['where', 'p.user_id = :userId', { userId: VIEWER_ID }],
      ['andWhere', 'p.archived_at IS NULL'],
      ['andWhere', UNREAD_THREAD_FRAGMENT],
      ['andWhere', PERSON_BLOCK_FRAGMENT, { unreadGroupKind: 'group' }],
      [
        'andWhere',
        normaliseSql(
          `NOT ${seatExcludedFromMailboxPredicate('p.conversation_id', ':userId')}`,
        ),
      ],
      ['setParameter', 'messageSubjectType', 'message'],
      ['setParameter', 'hiddenForUserId', VIEWER_ID],
    ]);
  });
});
