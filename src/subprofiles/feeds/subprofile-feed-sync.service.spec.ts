import type { DataSource, Repository } from 'typeorm';
import { SubprofileFeed } from '../entities/subprofile-feed.entity';
import {
  FEED_SYNC_BATCH_SIZE,
  FEED_SYNC_LOCK_KEY,
  SubprofileFeedSyncService,
} from './subprofile-feed-sync.service';
import type { SubprofileFeedsService } from './subprofile-feeds.service';

describe('SubprofileFeedSyncService', () => {
  let feeds: { find: jest.Mock };
  let feedsService: { syncFeed: jest.Mock };
  let lockRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let service: SubprofileFeedSyncService;

  beforeEach(() => {
    feeds = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'feed-1' },
          { id: 'feed-2' },
          { id: 'feed-3' },
        ]),
    };
    feedsService = { syncFeed: jest.fn().mockResolvedValue(undefined) };
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    service = new SubprofileFeedSyncService(
      feeds as unknown as Repository<SubprofileFeed>,
      feedsService as unknown as SubprofileFeedsService,
      {
        createQueryRunner: () => lockRunner,
      } as unknown as DataSource,
    );
  });

  it('uses an advisory-lock key no other job in src/ takes', () => {
    expect(FEED_SYNC_LOCK_KEY).toBe(793_640_004_000);
    for (const taken of [
      793640001, 793_640_002_000, 793_640_003_000, 793_640_003_001,
    ]) {
      expect(FEED_SYNC_LOCK_KEY).not.toBe(taken);
    }
  });

  it('syncs every due feed as a scheduled sync under the sweep lock', async () => {
    await service.syncDueFeeds();
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [FEED_SYNC_LOCK_KEY],
    );
    const [findOptions] = feeds.find.mock.calls[0] as [
      { take: number; order: unknown },
    ];
    expect(findOptions.take).toBe(FEED_SYNC_BATCH_SIZE);
    expect(findOptions.order).toEqual({ nextCheckAt: 'ASC' });
    expect(feedsService.syncFeed).toHaveBeenCalledTimes(3);
    expect(feedsService.syncFeed).toHaveBeenCalledWith(
      { id: 'feed-1' },
      { kind: 'scheduled' },
    );
    expect(lockRunner.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [FEED_SYNC_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('does nothing when another replica holds the lock', async () => {
    lockRunner.query.mockResolvedValueOnce([{ locked: false }]);
    await service.syncDueFeeds();
    expect(feeds.find).not.toHaveBeenCalled();
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('keeps sweeping when one feed throws', async () => {
    feedsService.syncFeed
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    await expect(service.sweep(new Date())).resolves.toBe(3);
    expect(feedsService.syncFeed).toHaveBeenCalledTimes(3);
  });
});
