import { ConversationKind } from './entities/conversation.entity';
import { MessageKind } from './entities/message.entity';
import {
  notFromBlockedGroupMemberPredicate,
  notPastViewerLeftAtPredicate,
  withinLeftAtCeilingPredicate,
} from './message-visibility-predicates';
import { MessagingCoreService } from './messaging-core.service';

/**
 * ENG-401 and ENG-402: the inbox reads a message for the caller only when
 * the thread would show it to them.
 *
 *  - ENG-401: a member who left or was removed from a group reads nothing
 *    posted after their `leftAt`. History already stopped there; the inbox
 *    preview did not, so a removed member kept reading the newest message's
 *    sender and body. The preview, the per-thread unread count and the
 *    mention flag all apply the ceiling now.
 *  - ENG-402: PRD-354 hides a group message from someone blocked either way
 *    with the caller. The preview, the per-thread unread count and the
 *    mention flag apply the same filter, so the row never previews a message
 *    the thread hides, and reading the thread clears the count.
 *
 * The nav badge's copy of both rules is pinned by `unread-badge-sql.spec.ts`
 * and `unread-and-delivered.spec.ts`; the list's sort key by
 * `list-conversations-pagination.spec.ts`; the attachment grant by
 * `files.controller.spec.ts` and `message-attachment-route.spec.ts`.
 */

const VIEWER_ID = 'viewer';

function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface RecordedQuery {
  query: Record<string, jest.Mock>;
  clauses: string[];
  parameters: Record<string, unknown>;
}

function makeRecordingQuery(terminalResult: unknown): RecordedQuery {
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  const query = {} as Record<string, jest.Mock>;
  for (const method of [
    'select',
    'addSelect',
    'distinctOn',
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'groupBy',
  ]) {
    query[method] = jest.fn((...callArguments: unknown[]) => {
      if (typeof callArguments[0] === 'string') {
        clauses.push(normaliseSql(callArguments[0]));
      }
      const boundParameters = callArguments.find(
        (argument) =>
          typeof argument === 'object' &&
          argument !== null &&
          !Array.isArray(argument),
      );
      if (boundParameters) {
        Object.assign(parameters, boundParameters);
      }
      return query;
    });
  }
  query.setParameter = jest.fn((name: string, value: unknown) => {
    parameters[name] = value;
    return query;
  });
  query.getMany = jest.fn().mockResolvedValue(terminalResult);
  query.getRawMany = jest.fn().mockResolvedValue(terminalResult);
  return { query, clauses, parameters };
}

function makeCore(query: Record<string, jest.Mock>): MessagingCoreService {
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, {
    messages: { createQueryBuilder: jest.fn(() => query) },
  });
  return core;
}

describe('the shared visibility predicates', () => {
  it('ceilings a joined seat at its leftAt, inclusive, and leaves an active seat unbounded', () => {
    expect(withinLeftAtCeilingPredicate('m.created_at', 'p')).toBe(
      '(p.left_at IS NULL OR m.created_at <= p.left_at)',
    );
  });

  it("ceilings a builder with no seat join through the viewer's own seat", () => {
    const fragment = normaliseSql(
      notPastViewerLeftAtPredicate('m', ':viewerId'),
    );
    expect(fragment.startsWith('NOT EXISTS')).toBe(true);
    expect(fragment).toContain(
      '"left_seat"."conversation_id" = m.conversation_id',
    );
    expect(fragment).toContain('"left_seat"."user_id" = :viewerId');
    expect(fragment).toContain('"left_seat"."left_at" IS NOT NULL');
    // Strictly after: a message at the exact instant the member left stays
    // theirs, matching the inclusive `<=` the joined form and history use.
    expect(fragment).toContain('m.created_at > "left_seat"."left_at"');
  });

  it('hides a blocked sender either way, in group threads alone, and keeps system pills', () => {
    const fragment = normaliseSql(
      notFromBlockedGroupMemberPredicate('m', ':viewerId'),
    );
    expect(fragment).toBe(
      normaliseSql(`(
        m.kind = '${MessageKind.System}'
        OR m.sender_id IS NULL
        OR m.sender_id <> ALL (ARRAY(
          SELECT "blocked_by_viewer"."blocked_id" FROM "blocks" "blocked_by_viewer"
            WHERE "blocked_by_viewer"."blocker_id" = :viewerId
          UNION ALL
          SELECT "blocker_of_viewer"."blocker_id" FROM "blocks" "blocker_of_viewer"
            WHERE "blocker_of_viewer"."blocked_id" = :viewerId
        ))
        OR NOT EXISTS (
          SELECT 1 FROM "conversations" "group_block_conversation"
          WHERE "group_block_conversation"."id" = m.conversation_id
            AND "group_block_conversation"."kind" = '${ConversationKind.Group}'
        )
      )`),
    );
  });

  // Fix round 1: the blocked set must not reference the message row, so
  // Postgres evaluates it once per query (an InitPlan) for a whole inbox.
  it("computes the viewer's blocked set without correlating to the message row", () => {
    const fragment = normaliseSql(
      notFromBlockedGroupMemberPredicate('m', ':viewerId'),
    );
    const blockedSet = fragment.slice(
      fragment.indexOf('ARRAY('),
      fragment.indexOf('OR NOT EXISTS'),
    );
    expect(blockedSet).toContain('UNION ALL');
    expect(blockedSet).not.toContain('m.');
  });
});

describe('the inbox preview (lastMessagesByConversation)', () => {
  it("stops at the viewer's own leftAt, bound to the viewer", async () => {
    const { query, clauses, parameters } = makeRecordingQuery([]);

    await makeCore(query).lastMessagesByConversation(
      ['group-1', 'direct-1'],
      VIEWER_ID,
    );

    expect(clauses).toContain(
      normaliseSql(notPastViewerLeftAtPredicate('m', ':hiddenForUserId')),
    );
    expect(parameters.hiddenForUserId).toBe(VIEWER_ID);
  });

  it('skips a group message from a member blocked either way with the viewer', async () => {
    const { query, clauses, parameters } = makeRecordingQuery([]);

    await makeCore(query).lastMessagesByConversation(['group-1'], VIEWER_ID);

    expect(clauses).toContain(
      normaliseSql(notFromBlockedGroupMemberPredicate('m', ':hiddenForUserId')),
    );
    expect(parameters.hiddenForUserId).toBe(VIEWER_ID);
  });

  it('still picks the newest surviving row per conversation', async () => {
    const newestVisible = { id: 'message-1', conversationId: 'group-1' };
    const { query } = makeRecordingQuery([newestVisible]);

    const previews = await makeCore(query).lastMessagesByConversation(
      ['group-1'],
      VIEWER_ID,
    );

    expect(query.distinctOn).toHaveBeenCalledWith(['m.conversation_id']);
    expect(query.orderBy).toHaveBeenCalledWith('m.conversation_id', 'ASC');
    expect(query.addOrderBy).toHaveBeenCalledWith('m.created_at', 'DESC');
    expect(previews.get('group-1')).toBe(newestVisible);
  });
});

describe('the per-thread unread count (unreadCountsByConversation)', () => {
  it('applies the leftAt ceiling on the joined seat and the group block filter', async () => {
    const { query, clauses, parameters } = makeRecordingQuery([]);

    await makeCore(query).unreadCountsByConversation(['group-1'], VIEWER_ID);

    expect(clauses).toContain(
      '(p.left_at IS NULL OR m.created_at <= p.left_at)',
    );
    expect(clauses).toContain(
      normaliseSql(notFromBlockedGroupMemberPredicate('m', ':userId')),
    );
    expect(parameters.userId).toBe(VIEWER_ID);
  });
});

describe('the unread-mention flag (hasUnreadMentionByConversation)', () => {
  it('applies the leftAt ceiling and the group block filter', async () => {
    const { query, clauses, parameters } = makeRecordingQuery([]);

    await makeCore(query).hasUnreadMentionByConversation(
      ['group-1'],
      VIEWER_ID,
      'viewer-slug',
    );

    expect(clauses).toContain(
      '(p.left_at IS NULL OR m.created_at <= p.left_at)',
    );
    expect(clauses).toContain(
      normaliseSql(notFromBlockedGroupMemberPredicate('m', ':userId')),
    );
    expect(parameters.userId).toBe(VIEWER_ID);
  });
});
