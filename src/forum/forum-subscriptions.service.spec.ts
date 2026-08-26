import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForumThreadSubscription } from './entities/forum-thread-subscription.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';

/**
 * SOC-13 thread following. The insert path is an `ON CONFLICT DO NOTHING`
 * query-builder chain (idempotent by construction), so it is asserted through a
 * chainable stub rather than a live repository.
 */
describe('ForumSubscriptionsService', () => {
  let service: ForumSubscriptionsService;
  let subscriptions: {
    exists: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // Typed with named properties rather than an index signature, so
  // `noUncheckedIndexedAccess` does not widen every read to `| undefined`.
  let insertChain: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(async () => {
    insertChain = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    insertChain.insert.mockReturnValue(insertChain);
    insertChain.into.mockReturnValue(insertChain);
    insertChain.values.mockReturnValue(insertChain);
    insertChain.orIgnore.mockReturnValue(insertChain);

    subscriptions = {
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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

  it('inserts a follow with ON CONFLICT DO NOTHING, so a repeat follow is a no-op', async () => {
    await service.subscribe('thread-1', 'user-1');

    expect(insertChain.orIgnore).toHaveBeenCalled();
    expect(insertChain.values).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userId: 'user-1',
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
