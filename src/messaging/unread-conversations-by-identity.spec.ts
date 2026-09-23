import { MessagingCoreService } from './messaging-core.service';
import { seatExcludedFromMailboxPredicate } from './mailbox-seats';
import { countUnreadConversationsByIdentity } from './unread-conversations-query';

/**
 * Task 15: the mailbox switcher's per-identity unread counts read the nav
 * badge's own definition (`applyUnreadConversationScope`), so a mailbox's
 * number is the badge restricted to the member's seats in that mailbox.
 * Each builder here records every call made on it, in order, so the two
 * queries can be compared clause for clause.
 */

const VIEWER_ID = 'viewer';

type RecordedCall = [method: string, ...parameters: unknown[]];

const SCOPE_METHODS = ['innerJoin', 'where', 'andWhere', 'setParameter'];

function makeRecordingQuery(terminalResult: unknown) {
  const calls: RecordedCall[] = [];
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
      calls.push([method, ...parameters]);
      return query;
    });
  }
  query.getRawOne = jest.fn().mockResolvedValue(terminalResult);
  query.getRawMany = jest.fn().mockResolvedValue(terminalResult);
  return { query, calls };
}

/** The nav badge query, run through the real `unreadConversationCount`. */
async function recordBadgeQuery(): Promise<RecordedCall[]> {
  const { query, calls } = makeRecordingQuery({ count: '0' });
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, {
    participants: { createQueryBuilder: jest.fn(() => query) },
  });
  await core.unreadConversationCount(VIEWER_ID);
  return calls;
}

describe('countUnreadConversationsByIdentity', () => {
  it("narrows the member's seats with exactly the nav badge's clauses, then only by identity", async () => {
    const badgeCalls = await recordBadgeQuery();
    const { query, calls } = makeRecordingQuery([]);
    const participants = { createQueryBuilder: jest.fn(() => query) };

    await countUnreadConversationsByIdentity(participants as never, VIEWER_ID, [
      'profile-identity',
      'cafe-identity',
    ]);

    const scopeOf = (recorded: RecordedCall[]) =>
      recorded.filter(([method]) => SCOPE_METHODS.includes(method));
    const identityFilter: RecordedCall = [
      'andWhere',
      'p.identity_id IN (:...mailboxIdentityIds)',
      { mailboxIdentityIds: ['profile-identity', 'cafe-identity'] },
    ];
    expect(scopeOf(calls)).toEqual([...scopeOf(badgeCalls), identityFilter]);
    expect(participants.createQueryBuilder).toHaveBeenCalledWith('p');
    expect(query.groupBy).toHaveBeenCalledWith('p.identity_id');
    expect(query.addSelect).toHaveBeenCalledWith(
      'COUNT(DISTINCT p.conversation_id)',
      'count',
    );
  });

  it('never counts a thread whose seat is excluded from the mailbox, by a block or a departure', async () => {
    const { query } = makeRecordingQuery([]);

    await countUnreadConversationsByIdentity(
      { createQueryBuilder: jest.fn(() => query) } as never,
      VIEWER_ID,
      ['cafe-identity'],
    );

    expect(query.andWhere).toHaveBeenCalledWith(
      `NOT ${seatExcludedFromMailboxPredicate('p.conversation_id', ':userId')}`,
    );
  });

  it('answers in one grouped query, keyed by identity, however many identities are asked about', async () => {
    const { query } = makeRecordingQuery([
      { identityId: 'profile-identity', count: '3' },
      { identityId: 'cafe-identity', count: '2' },
    ]);
    const participants = { createQueryBuilder: jest.fn(() => query) };

    const counts = await countUnreadConversationsByIdentity(
      participants as never,
      VIEWER_ID,
      ['profile-identity', 'cafe-identity', 'cafe-identity', 'bar-identity'],
    );

    expect(participants.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(query.getRawMany).toHaveBeenCalledTimes(1);
    expect(query.andWhere).toHaveBeenCalledWith(
      'p.identity_id IN (:...mailboxIdentityIds)',
      {
        mailboxIdentityIds: [
          'profile-identity',
          'cafe-identity',
          'bar-identity',
        ],
      },
    );
    expect(counts).toEqual(
      new Map([
        ['profile-identity', 3],
        ['cafe-identity', 2],
      ]),
    );
  });

  it('runs no query at all for no identities', async () => {
    const participants = { createQueryBuilder: jest.fn() };

    await expect(
      countUnreadConversationsByIdentity(participants as never, VIEWER_ID, []),
    ).resolves.toEqual(new Map());
    expect(participants.createQueryBuilder).not.toHaveBeenCalled();
  });
});
