import { MessagingCoreService } from './messaging-core.service';
import { countUnreadConversationsByIdentity } from './unread-conversations-query';

/**
 * Task 15 fix round 1 ruling: a message sent AS the seat's own identity is
 * never unread for that seat. On a shared mailbox, a colleague's reply sent
 * as the business is the business speaking, so it leaves every other staff
 * member's count alone, while the customer's message still counts. Every
 * unread formula carries the rule: the nav badge and the per-mailbox counts
 * (through `applyUnreadConversationScope`), the inbox row's per-thread count
 * (`unreadCountsByConversation`) and the unread-mention flag
 * (`hasUnreadMentionByConversation`).
 *
 * On a profile seat the rule is the one `m.sender_id != :userId` already
 * applies: a member has exactly one profile identity, and only that member's
 * own sends carry it.
 */

const VIEWER_ID = 'viewer';
const OWN_IDENTITY_RULE = 'm.sender_identity_id IS DISTINCT FROM p.identity_id';

function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function makeRecordingQuery(terminalResult: unknown) {
  const clauses: string[] = [];
  const query = {} as Record<string, jest.Mock>;
  for (const method of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'setParameter',
    'groupBy',
  ]) {
    query[method] = jest.fn((...parameters: unknown[]) => {
      if (typeof parameters[0] === 'string') {
        clauses.push(normaliseSql(parameters[0]));
      }
      return query;
    });
  }
  query.getRawOne = jest.fn().mockResolvedValue(terminalResult);
  query.getRawMany = jest.fn().mockResolvedValue(terminalResult);
  return { query, clauses };
}

function makeCore(repositories: Record<string, unknown>): MessagingCoreService {
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, repositories);
  return core;
}

/** The per-message part of the badge scope: the EXISTS over "messages". */
function unreadMessageSubquery(clauses: string[]): string {
  const fragment = clauses.find((sql) => sql.includes('marked_unread_at'));
  if (!fragment) {
    throw new Error('unread predicate was not applied');
  }
  return fragment.slice(fragment.indexOf('EXISTS ('));
}

describe('a message sent as the seat own identity is never unread for that seat', () => {
  it('the nav badge applies the rule inside its per-message subquery', async () => {
    const { query, clauses } = makeRecordingQuery({ count: '0' });
    const core = makeCore({
      participants: { createQueryBuilder: jest.fn(() => query) },
    });

    await core.unreadConversationCount(VIEWER_ID);

    expect(unreadMessageSubquery(clauses)).toContain(OWN_IDENTITY_RULE);
  });

  it('the per-mailbox counts apply the same rule', async () => {
    const { query, clauses } = makeRecordingQuery([]);

    await countUnreadConversationsByIdentity(
      { createQueryBuilder: jest.fn(() => query) } as never,
      VIEWER_ID,
      ['cafe-identity'],
    );

    expect(unreadMessageSubquery(clauses)).toContain(OWN_IDENTITY_RULE);
  });

  it("the inbox row's per-thread unread count applies it", async () => {
    const { query, clauses } = makeRecordingQuery([]);
    const core = makeCore({
      messages: { createQueryBuilder: jest.fn(() => query) },
    });

    await core.unreadCountsByConversation(['conversation-1'], VIEWER_ID);

    expect(clauses).toContain(OWN_IDENTITY_RULE);
    // The customer's message still counts: the rule reads the sending
    // identity, and the caller's own sends stay out through `sender_id`.
    expect(clauses).toContain('m.sender_id != :userId');
  });

  it('the unread-mention flag applies it', async () => {
    const { query, clauses } = makeRecordingQuery([]);
    const core = makeCore({
      messages: { createQueryBuilder: jest.fn(() => query) },
    });

    await core.hasUnreadMentionByConversation(
      ['conversation-1'],
      VIEWER_ID,
      'viewer-slug',
    );

    expect(clauses).toContain(OWN_IDENTITY_RULE);
  });
});
