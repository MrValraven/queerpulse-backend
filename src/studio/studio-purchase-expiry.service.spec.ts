import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { MIGRATION_LOCK_KEY } from '../database/migration-lock';
import {
  MATCHING_LOCK_KEY,
  RETENTION_LOCK_KEY,
} from '../go-together/go-together-matching.service';
import { IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY } from '../identities/identity-mailbox-reconciliation.service';
import { FEED_SYNC_LOCK_KEY } from '../subprofiles/feeds/subprofile-feed-sync.service';
import { LISTENING_PRUNE_LOCK_KEY } from './studio-listening-prune.service';
import { MILESTONE_SWEEP_LOCK_KEY } from './studio-milestone-sweep.service';
import { STUDIO_PURCHASE_EXPIRED } from './studio-purchase.events';
import {
  EXPIRE_BATCH_SQL,
  PURCHASE_EXPIRY_LOCK_KEY,
  StudioPurchaseExpiryService,
} from './studio-purchase-expiry.service';
import { SCHEDULED_RELEASES_LOCK_KEY } from './studio-scheduled-releases.service';
import { StudioKeptAudioService } from './studio-kept-audio.service';

function buildIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}-${String(index).padStart(4, '0')}`,
  );
}

describe('StudioPurchaseExpiryService', () => {
  let callOrder: string[];
  let batchResults: (string[] | Error)[];
  let transaction: jest.Mock;
  let lockRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let emit: jest.Mock;
  let retryPendingCopies: jest.Mock;
  let sweepOrphans: jest.Mock;
  let service: StudioPurchaseExpiryService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    callOrder = [];
    batchResults = [[]];
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    transaction = jest.fn(
      async (callback: (manager: EntityManager) => Promise<string[]>) => {
        callOrder.push('begin');
        const manager = {
          query: jest.fn(() => {
            callOrder.push('batch');
            const next = batchResults.shift() ?? [];
            if (next instanceof Error) {
              return Promise.reject(next);
            }
            return Promise.resolve(next.map((id) => ({ id })));
          }),
        } as unknown as EntityManager;
        const result = await callback(manager);
        callOrder.push('committed');
        return result;
      },
    );
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          callOrder.push('lock');
          return Promise.resolve([{ locked: true }]);
        }
        callOrder.push('unlock');
        return Promise.resolve([]);
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    emit = jest.fn((_eventName: string, _payload: unknown) => {
      callOrder.push('emitted');
      return true;
    });
    retryPendingCopies = jest.fn(() => {
      callOrder.push('retryPendingCopies');
      return Promise.resolve();
    });
    sweepOrphans = jest.fn(() => {
      callOrder.push('sweepOrphans');
      return Promise.resolve();
    });
    service = new StudioPurchaseExpiryService(
      {
        transaction,
        createQueryRunner: () => lockRunner,
      } as unknown as DataSource,
      { emit } as unknown as EventEmitter2,
      { retryPendingCopies, sweepOrphans } as unknown as StudioKeptAudioService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses its own advisory lock key, distinct from every other key', () => {
    expect(PURCHASE_EXPIRY_LOCK_KEY).toBe(793_640_008_000);
    expect([
      SCHEDULED_RELEASES_LOCK_KEY,
      MILESTONE_SWEEP_LOCK_KEY,
      LISTENING_PRUNE_LOCK_KEY,
      FEED_SYNC_LOCK_KEY,
      MATCHING_LOCK_KEY,
      RETENTION_LOCK_KEY,
      IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY,
      MIGRATION_LOCK_KEY,
    ]).not.toContain(PURCHASE_EXPIRY_LOCK_KEY);
  });

  it('skips the run when another process holds the lock', async () => {
    lockRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await service.runDaily();

    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [793640008000],
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(retryPendingCopies).not.toHaveBeenCalled();
    expect(sweepOrphans).not.toHaveBeenCalled();
    expect(lockRunner.query).not.toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      expect.anything(),
    );
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('repeats the batch until it returns fewer than 500 rows, each in its own transaction', async () => {
    batchResults = [buildIds('a', 500), buildIds('b', 500), buildIds('c', 3)];

    const expiredIds = await service.expirePendingOnce();

    expect(transaction).toHaveBeenCalledTimes(3);
    expect(expiredIds).toHaveLength(1003);
    expect(callOrder.filter((step) => step === 'begin')).toHaveLength(3);
    expect(callOrder.filter((step) => step === 'committed')).toHaveLength(3);
  });

  it('emits expired only for the ids the batch returned, after the batch commits', async () => {
    batchResults = [['purchase-1', 'purchase-2']];

    await service.expirePendingOnce();

    expect(callOrder).toEqual([
      'begin',
      'batch',
      'committed',
      'emitted',
      'emitted',
    ]);
    expect(emit.mock.calls).toEqual([
      [STUDIO_PURCHASE_EXPIRED, { purchaseId: 'purchase-1' }],
      [STUDIO_PURCHASE_EXPIRED, { purchaseId: 'purchase-2' }],
    ]);
  });

  it('emits nothing for a failed batch', async () => {
    batchResults = [new Error('deadlock detected')];

    await expect(service.expirePendingOnce()).rejects.toThrow(
      'deadlock detected',
    );

    expect(emit).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('committed');
  });

  it('retries kept copies and sweeps orphans after the expiry, under the same lock', async () => {
    batchResults = [['purchase-1']];

    await service.runDaily();

    expect(callOrder).toEqual([
      'lock',
      'begin',
      'batch',
      'committed',
      'emitted',
      'retryPendingCopies',
      'sweepOrphans',
      'unlock',
    ]);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('logs the expired count only', async () => {
    batchResults = [['purchase-1', 'purchase-2', 'purchase-3']];

    await service.runDaily();

    expect(logSpy.mock.calls.flat().join(' ')).toBe(
      'Expired 3 pending Studio purchases',
    );
  });

  it('logs every failure as the error class and code only', async () => {
    const failure = Object.assign(new Error('secret detail 4711'), {
      code: '40P01',
    });
    batchResults = [failure];
    lockRunner.release.mockRejectedValueOnce(new TypeError('socket gone 9'));

    await expect(service.runDaily()).resolves.toBeUndefined();

    const warnings = warnSpy.mock.calls.flat().join(' | ');
    expect(warnings).toContain('Purchase expiry failed: Error (code 40P01)');
    expect(warnings).toContain(
      'Purchase expiry connection release failed: TypeError',
    );
    expect(warnings).not.toContain('secret detail');
    expect(warnings).not.toContain('socket gone');
  });

  it('reads the batch through WITH and uses the 30-day window', () => {
    expect(EXPIRE_BATCH_SQL).toMatch(/^WITH /);
    expect(EXPIRE_BATCH_SQL).toContain(`interval '30 days'`);
    expect(EXPIRE_BATCH_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(EXPIRE_BATCH_SQL).toContain('LIMIT 500');
    expect(EXPIRE_BATCH_SQL).toContain(`"status" = 'pending'`);
  });

  it('still sweeps, unlocks and releases the connection when the copy retry throws', async () => {
    retryPendingCopies.mockRejectedValueOnce(new Error('storage down'));

    await expect(service.runDaily()).resolves.toBeUndefined();

    expect(sweepOrphans).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.flat()).toEqual([
      'Purchase kept copy retry failed: Error',
    ]);
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [PURCHASE_EXPIRY_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('retries copies and sweeps after a failed batch, logging the batches that committed', async () => {
    batchResults = [
      buildIds('a', 500),
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    ];

    await expect(service.runDaily()).resolves.toBeUndefined();

    expect(callOrder.slice(-3)).toEqual([
      'retryPendingCopies',
      'sweepOrphans',
      'unlock',
    ]);
    expect(logSpy.mock.calls.flat()).toEqual([
      'Expired 500 pending Studio purchases',
    ]);
    expect(warnSpy.mock.calls.flat()).toEqual([
      'Purchase expiry failed: Error (code 40P01)',
    ]);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('runs the expiry and the copy retry when the sweep throws', async () => {
    batchResults = [['purchase-1']];
    sweepOrphans.mockRejectedValueOnce(
      Object.assign(new Error('bucket gone'), { code: 'NoSuchBucket' }),
    );

    await expect(service.runDaily()).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(retryPendingCopies).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.flat()).toEqual([
      'Purchase kept sweep failed: Error (code NoSuchBucket)',
    ]);
    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [PURCHASE_EXPIRY_LOCK_KEY],
    );
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });
});
