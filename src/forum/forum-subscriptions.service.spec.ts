import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForumThreadSubscription } from './entities/forum-thread-subscription.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';

/**
 * SOC-13 thread following and the C7/PRD-170 read watermark. Both write paths
 * are `ON CONFLICT DO UPDATE` query-builder chains (idempotent by
 * construction), so they are asserted through a chainable stub rather than a
 * live repository.
 */
describe('ForumSubscriptionsService', () => {
  let service: ForumSubscriptionsService;
  let subscriptions: {
    exists: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
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
    await service.markRead('thread-1', 'user-1');

    // The whole point of C7: opening a thread must not sign anybody up for a
    // notification per reply.
    expect(insertChain.values).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userId: 'user-1',
      isFollowing: false,
      lastReadAt: expect.any(Date) as unknown,
    });
    // ...and a member who already follows the thread keeps following it: only
    // the watermark is overwritten on conflict.
    expect(insertChain.orUpdate).toHaveBeenCalledWith(
      ['last_read_at'],
      ['thread_id', 'user_id'],
    );
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
