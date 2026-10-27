import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MIGRATION_LOCK_KEY } from '../database/migration-lock';
import {
  MATCHING_LOCK_KEY,
  RETENTION_LOCK_KEY,
} from '../go-together/go-together-matching.service';
import { IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY } from '../identities/identity-mailbox-reconciliation.service';
import { FEED_SYNC_LOCK_KEY } from '../subprofiles/feeds/subprofile-feed-sync.service';
import { STUDIO_LISTENING_RETENTION_INTERVAL } from './studio-listening-history';
import {
  LISTENING_PRUNE_LOCK_KEY,
  LISTENING_PRUNE_SQL,
  StudioListeningPruneService,
} from './studio-listening-prune.service';
import { MILESTONE_SWEEP_LOCK_KEY } from './studio-milestone-sweep.service';
import { SCHEDULED_RELEASES_LOCK_KEY } from './studio-scheduled-releases.service';

describe('StudioListeningPruneService', () => {
  let query: jest.Mock;
  let lockRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let service: StudioListeningPruneService;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    query = jest.fn().mockResolvedValue([{ pruned_count: 3 }]);
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
        ),
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    service = new StudioListeningPruneService({
      query,
      createQueryRunner: () => lockRunner,
    } as unknown as DataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses its own advisory lock key, distinct from every other sweep', () => {
    expect(LISTENING_PRUNE_LOCK_KEY).toBe(793_640_007_000);
    expect([
      SCHEDULED_RELEASES_LOCK_KEY,
      MILESTONE_SWEEP_LOCK_KEY,
      FEED_SYNC_LOCK_KEY,
      MATCHING_LOCK_KEY,
      RETENTION_LOCK_KEY,
      IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY,
      MIGRATION_LOCK_KEY,
    ]).not.toContain(LISTENING_PRUNE_LOCK_KEY);
  });

  it('runs one prune under the lock and frees it on the same connection', async () => {
    await service.pruneListeningHistory();

    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LISTENING_PRUNE_LOCK_KEY],
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(LISTENING_PRUNE_SQL);
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [LISTENING_PRUNE_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('skips the tick when another process holds the lock', async () => {
    lockRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await service.pruneListeningHistory();

    expect(query).not.toHaveBeenCalled();
    expect(lockRunner.query).not.toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      expect.anything(),
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('logs a failed prune, frees the lock and throws nothing back at the scheduler', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.pruneListeningHistory()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    );
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [LISTENING_PRUNE_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('logs a failure to connect and still releases the connection', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    lockRunner.connect.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(service.pruneListeningHistory()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pool exhausted'),
    );
    expect(query).not.toHaveBeenCalled();
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('deletes listens older than 13 months and touches nothing else', () => {
    expect(STUDIO_LISTENING_RETENTION_INTERVAL).toBe('13 months');
    expect(LISTENING_PRUNE_SQL).toContain(
      `interval '${STUDIO_LISTENING_RETENTION_INTERVAL}'`,
    );
    expect(LISTENING_PRUNE_SQL).toContain(`interval '13 months'`);
    expect(LISTENING_PRUNE_SQL).toContain('DELETE FROM "studio_listens"');
    expect(LISTENING_PRUNE_SQL).not.toMatch(
      /studio_track_play_daily|studio_supporters/,
    );
  });

  it('logs the deleted count only', async () => {
    query.mockResolvedValue([{ pruned_count: 12 }]);

    await service.pruneListeningHistory();

    expect(logSpy.mock.calls.flat().join(' ')).toMatch(
      /^Pruned 12 listening history rows$/,
    );
  });

  it('reads an empty result as zero rows deleted', async () => {
    query.mockResolvedValueOnce([]);

    expect(await service.pruneOnce()).toBe(0);
  });
});
