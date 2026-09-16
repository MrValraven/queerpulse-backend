import { Logger } from '@nestjs/common';
import { PushSubscriptionRetentionService } from './push-subscription-retention.service';

const FROZEN_NOW = new Date('2026-09-14T02:00:00.000Z').getTime();

/**
 * Chainable stand-in for the batched `DELETE ... WHERE id IN (SELECT ...)`
 * builder `deleteInBatches` runs. `execute` resolves each batch's affected
 * row count in order.
 */
interface DeleteQueryMock {
  delete: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  execute: jest.Mock;
}

function makeRepository(affectedPerBatch: number[]) {
  const query = {} as DeleteQueryMock;
  const self = (): DeleteQueryMock => query;
  query.delete = jest.fn(self);
  query.from = jest.fn(self);
  query.where = jest.fn(self);
  query.execute = jest.fn().mockResolvedValue({ affected: 0 });
  for (const affected of affectedPerBatch) {
    query.execute.mockResolvedValueOnce({ affected });
  }
  const repository = {
    metadata: {
      tableName: 'push_subscriptions',
      primaryColumns: [{ databaseName: 'id' }],
    },
    target: 'PushSubscription',
    createQueryBuilder: jest.fn(() => query),
  };
  return { repository, query };
}

function makeConfig(values: Record<string, number> = {}) {
  return {
    get: jest.fn((key: string, fallback: number) => values[key] ?? fallback),
  };
}

describe('PushSubscriptionRetentionService.purgeStaleSubscriptions', () => {
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes only subscriptions nothing has confirmed alive within the 90-day default window', async () => {
    const { repository, query } = makeRepository([3]);
    const config = makeConfig();
    const service = new PushSubscriptionRetentionService(
      repository as never,
      config as never,
    );

    await service.purgeStaleSubscriptions();

    expect(config.get).toHaveBeenCalledWith(
      'retention.pushSubscriptionStaleDays',
      90,
    );
    const [whereSql, parameters] = query.where.mock.calls[0] as [
      string,
      { cutoff: Date; retentionBatchSize: number },
    ];
    // A device is alive if it was delivered to or (re)subscribed recently; a
    // never-delivered row ages from its creation.
    expect(whereSql).toContain('COALESCE(last_used_at, created_at) < :cutoff');
    expect(whereSql).toContain('LIMIT :retentionBatchSize');
    expect(parameters.cutoff.toISOString()).toBe('2026-06-16T02:00:00.000Z');
    expect(parameters.retentionBatchSize).toBe(1000);
    // Fewer rows than a full batch means nothing is left, so the loop stops.
    expect(query.execute).toHaveBeenCalledTimes(1);
  });

  it('honours a configured window and batch size, and never runs past the batch cap', async () => {
    const { repository, query } = makeRepository([2, 2, 2, 2]);
    const config = makeConfig({
      'retention.pushSubscriptionStaleDays': 30,
      'retention.batchSize': 2,
      'retention.maxBatchesPerRun': 3,
    });
    const service = new PushSubscriptionRetentionService(
      repository as never,
      config as never,
    );

    await service.purgeStaleSubscriptions();

    const [, parameters] = query.where.mock.calls[0] as [
      string,
      { cutoff: Date; retentionBatchSize: number },
    ];
    expect(parameters.cutoff.toISOString()).toBe('2026-08-15T02:00:00.000Z');
    expect(parameters.retentionBatchSize).toBe(2);
    expect(query.execute).toHaveBeenCalledTimes(3);
  });

  it('swallows and logs a failure so the scheduler cannot crash the process', async () => {
    const repository = {
      metadata: {
        tableName: 'push_subscriptions',
        primaryColumns: [{ databaseName: 'id' }],
      },
      createQueryBuilder: () => {
        throw new Error('connection reset');
      },
    };
    const service = new PushSubscriptionRetentionService(
      repository as never,
      makeConfig() as never,
    );

    await expect(service.purgeStaleSubscriptions()).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('connection reset'),
    );
  });
});
