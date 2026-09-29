import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForumThreadSubscription } from './entities/forum-thread-subscription.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';

/**
 * SOC-13 thread following and the C7/PRD-170 read watermark. Both write paths
 * are `ON CONFLICT DO UPDATE` statements (idempotent by construction): the
 * follow is a query-builder chain asserted through a chainable stub, and the
 * watermark is raw SQL asserted through the repository's `query` stub.
 */
describe('ForumSubscriptionsService', () => {
  let service: ForumSubscriptionsService;
  let subscriptions: {
    exists: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // Typed with named properties rather than an index signature, so
  // `noUncheckedIndexedAccess` does not widen every read to `| undefined`.
  let insertChain: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(async () => {
    insertChain = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      orUpdate: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    insertChain.insert.mockReturnValue(insertChain);
    insertChain.into.mockReturnValue(insertChain);
    insertChain.values.mockReturnValue(insertChain);
    insertChain.orIgnore.mockReturnValue(insertChain);
    insertChain.orUpdate.mockReturnValue(insertChain);

    subscriptions = {
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(insertChain),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForumSubscriptionsService,
        {
          provide: getRepositoryToken(ForumThreadSubscription),
          useValue: subscriptions,
        },
      ],
    }).compile();
    service = module.get(ForumSubscriptionsService);
  });

  it('follows by writing is_following, so a repeat follow is idempotent', async () => {
    await service.subscribe('thread-1', 'user-1');

    // `DO UPDATE`, not `DO NOTHING`: a member who has only ever OPENED the
    // thread already has a row (`is_following = false`), and `DO NOTHING` would
    // leave the Follow tap doing nothing at all (C7/PRD-170).
    expect(insertChain.orUpdate).toHaveBeenCalledWith(
      ['is_following'],
      ['thread_id', 'user_id'],
    );
    expect(insertChain.values).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userId: 'user-1',
      isFollowing: true,
    });
  });

  it('follows without disturbing the watermark underneath', async () => {
    await service.subscribe('thread-1', 'user-1');

    const [overwrittenColumns] = insertChain.orUpdate.mock.calls[0] as [
      string[],
    ];
    expect(overwrittenColumns).not.toContain('last_read_at');
  });

  it('stamps a read watermark WITHOUT subscribing the reader', async () => {
    const readAt = new Date('2026-09-01T10:00:00.000Z');
    await service.markRead('thread-1', 'user-1', readAt);

    const [sql, params] = subscriptions.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    // The whole point of C7: opening a thread must not sign anybody up for a
    // notification per reply. The insert writes `is_following = false`...
    expect(sql).toMatch(/VALUES \(\$1, \$2, false, \$3\)/);
    expect(params).toEqual(['thread-1', 'user-1', readAt]);
    // ...and a member who already follows the thread keeps following it: the
    // conflict arm sets the watermark alone.
    const conflictArm = sql.slice(sql.indexOf('DO UPDATE'));
    expect(conflictArm).toContain('"last_read_at" = GREATEST(');
    expect(conflictArm).not.toContain('is_following');
  });

  it('markRead never moves the watermark backward', async () => {
    await service.markRead(
      'thread-1',
      'user-1',
      new Date('2026-08-01T10:00:00.000Z'),
    );

    const [sql] = subscriptions.query.mock.calls[0] as [string];
    // PRD-409: a late request carrying an older stamp keeps the stored value,
    // because the conflict arm takes the later of the two.
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'GREATEST( COALESCE( "forum_thread_subscription"."last_read_at", EXCLUDED."last_read_at" ), EXCLUDED."last_read_at" )',
    );
    expect(sql).toContain('ON CONFLICT ("thread_id", "user_id") DO UPDATE');
  });

  it('unfollows by clearing the flag, never by deleting the watermark row', async () => {
    await service.unsubscribe('thread-1', 'user-1');

    expect(subscriptions.update).toHaveBeenCalledWith(
      { threadId: 'thread-1', userId: 'user-1' },
      { isFollowing: false },
    );
    // Deleting the row would reset where the member had read to, so everything
    // posted before the unfollow would come back as new.
    expect(subscriptions.delete).not.toHaveBeenCalled();
  });

  it('reads following as is_following, never as row existence', async () => {
    await service.isSubscribed('thread-1', 'viewer-1');

    expect(subscriptions.exists).toHaveBeenCalledWith({
      where: { threadId: 'thread-1', userId: 'viewer-1', isFollowing: true },
    });
  });

  it('never fans a reply out to a member who only READ the thread', async () => {
    await service.subscriberIdsToNotify('thread-1', 'replier-1');

    const [criteria] = subscriptions.find.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(criteria.where).toEqual({
      threadId: 'thread-1',
      isFollowing: true,
    });
  });

  it('never throws from an auto-subscribe: the post it follows has already committed', async () => {
    insertChain.execute.mockRejectedValueOnce(new Error('db is down'));

    await expect(
      service.subscribeQuietly('thread-1', 'user-1'),
    ).resolves.toBeUndefined();
  });

  it('reads the whole page of threads in one query, never one probe per row', async () => {
    subscriptions.find.mockResolvedValue([{ threadId: 'thread-2' }]);

    const followed = await service.subscribedThreadIds(
      ['thread-1', 'thread-2'],
      'viewer-1',
    );

    expect(subscriptions.find).toHaveBeenCalledTimes(1);
    expect(followed.has('thread-2')).toBe(true);
    expect(followed.has('thread-1')).toBe(false);
    const [criteria] = subscriptions.find.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(criteria.where).toMatchObject({ isFollowing: true });
  });

  it('answers false for an anonymous viewer without touching the database', async () => {
    expect(await service.isSubscribed('thread-1', '')).toBe(false);
    expect(subscriptions.exists).not.toHaveBeenCalled();
  });

  it('leaves the replier out of their own reply fan-out', async () => {
    subscriptions.find.mockResolvedValue([
      { userId: 'author-1' },
      { userId: 'replier-1' },
      { userId: 'follower-1' },
    ]);

    const recipients = await service.subscriberIdsToNotify(
      'thread-1',
      'replier-1',
    );

    expect(recipients).toEqual(['author-1', 'follower-1']);
  });
});
