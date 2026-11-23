import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PURCHASE_EXPIRY_LOCK_KEY } from '../studio/studio-purchase-expiry.service';
import { CommunityBadgeAwardingService } from './community-badge-awarding.service';
import {
  BACKFILL_COMMUNITY_SAVEPOINT_SQL,
  CLAIM_BACKFILL_BATCH_SQL,
  CLEAR_BACKFILL_SQL,
  COMMUNITY_BADGE_BACKFILL_LOCK_KEY,
  COMMUNITY_BADGE_SWEEP_LOCK_KEY,
  CommunityBadgeJobsService,
  RELEASE_BACKFILL_COMMUNITY_SAVEPOINT_SQL,
  ROLLBACK_BACKFILL_COMMUNITY_SAVEPOINT_SQL,
  SWEEP_COMMUNITIES_PAGE_SQL,
  SWEEP_FIRST_PAGE_AFTER_ID,
} from './community-badge-jobs.service';

function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function buildCommunityIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}-${String(index).padStart(4, '0')}`,
  );
}

describe('CommunityBadgeJobsService', () => {
  let manager: { query: jest.Mock };
  let transaction: jest.Mock;
  let poolQuery: jest.Mock;
  let lockRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let isLockFree: boolean;
  let awardCommunity: jest.Mock;
  let service: CommunityBadgeJobsService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    isLockFree = true;
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    manager = { query: jest.fn().mockResolvedValue([]) };
    transaction = jest.fn(
      (callback: (transactionManager: EntityManager) => Promise<unknown>) =>
        callback(manager as unknown as EntityManager),
    );
    poolQuery = jest.fn().mockResolvedValue([]);
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          return Promise.resolve([{ locked: isLockFree }]);
        }
        return Promise.resolve([]);
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    awardCommunity = jest.fn().mockResolvedValue(0);
    service = new CommunityBadgeJobsService(
      {
        transaction,
        query: poolQuery,
        createQueryRunner: () => lockRunner,
      } as unknown as DataSource,
      { awardCommunity } as unknown as CommunityBadgeAwardingService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the next free advisory lock keys after the purchase expiry', () => {
    expect(COMMUNITY_BADGE_BACKFILL_LOCK_KEY).toBe(793_640_009_000);
    expect(COMMUNITY_BADGE_SWEEP_LOCK_KEY).toBe(793_640_009_001);
    expect([
      PURCHASE_EXPIRY_LOCK_KEY,
      COMMUNITY_BADGE_SWEEP_LOCK_KEY,
    ]).not.toContain(COMMUNITY_BADGE_BACKFILL_LOCK_KEY);
  });

  describe('runBackfill', () => {
    it('awards a backfill batch silently and clears the flag', async () => {
      manager.query.mockResolvedValueOnce([
        { id: 'badge-1', community_id: 'c1' },
        { id: 'badge-2', community_id: 'c1' },
        { id: 'badge-3', community_id: 'c2' },
      ]);

      await service.runBackfill();

      expect(manager.query).toHaveBeenNthCalledWith(
        1,
        CLAIM_BACKFILL_BATCH_SQL,
      );
      expect(awardCommunity).toHaveBeenCalledTimes(2);
      expect(awardCommunity).toHaveBeenCalledWith(
        {
          communityId: 'c1',
          badgeIds: ['badge-1', 'badge-2'],
          shouldNotify: false,
          onlyReadyBadges: false,
        },
        manager,
      );
      expect(awardCommunity).toHaveBeenCalledWith(
        {
          communityId: 'c2',
          badgeIds: ['badge-3'],
          shouldNotify: false,
          onlyReadyBadges: false,
        },
        manager,
      );
      expect(manager.query).toHaveBeenCalledWith(CLEAR_BACKFILL_SQL, [
        ['badge-1', 'badge-2', 'badge-3'],
      ]);
      const lastCall = manager.query.mock.calls[
        manager.query.mock.calls.length - 1
      ] as unknown[];
      expect(lastCall[0]).toBe(CLEAR_BACKFILL_SQL);
      expect(logSpy).toHaveBeenCalledWith('Backfilled 3 community badges');
    });

    it('wraps each community award in its own savepoint', async () => {
      manager.query.mockResolvedValueOnce([
        { id: 'badge-1', community_id: 'c1' },
      ]);

      await service.runBackfill();

      const statements = manager.query.mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(statements).toEqual([
        CLAIM_BACKFILL_BATCH_SQL,
        BACKFILL_COMMUNITY_SAVEPOINT_SQL,
        RELEASE_BACKFILL_COMMUNITY_SAVEPOINT_SQL,
        CLEAR_BACKFILL_SQL,
      ]);
    });

    it('keeps the flag of a failed community and still clears the others', async () => {
      manager.query.mockResolvedValueOnce([
        { id: 'badge-1', community_id: 'c1' },
        { id: 'badge-2', community_id: 'c2' },
      ]);
      awardCommunity
        .mockRejectedValueOnce(new TypeError('secret detail c1'))
        .mockResolvedValueOnce(4);

      await service.runBackfill();

      expect(manager.query).toHaveBeenCalledWith(
        ROLLBACK_BACKFILL_COMMUNITY_SAVEPOINT_SQL,
      );
      expect(manager.query).toHaveBeenCalledWith(CLEAR_BACKFILL_SQL, [
        ['badge-2'],
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Community badge backfill failed for one community: TypeError',
      );
      const warnedText = warnSpy.mock.calls.flat().join(' ');
      expect(warnedText).not.toContain('secret detail');
      expect(warnedText).not.toContain('c1');
    });

    it('awards and clears nothing when no badge is flagged', async () => {
      await service.runBackfill();

      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(awardCommunity).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('skips the tick when another replica holds the lock', async () => {
      isLockFree = false;

      await service.runBackfill();

      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [COMMUNITY_BADGE_BACKFILL_LOCK_KEY],
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(awardCommunity).not.toHaveBeenCalled();
      expect(lockRunner.query).not.toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        expect.anything(),
      );
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });

    it('claims with SKIP LOCKED in request order', () => {
      const sql = collapsed(CLAIM_BACKFILL_BATCH_SQL);
      expect(sql).toContain(
        'ORDER BY "backfill_requested_at", "id" LIMIT 100 FOR NO KEY UPDATE SKIP LOCKED',
      );
      expect(sql).toContain('WHERE "backfill_requested_at" IS NOT NULL');
      expect(CLEAR_BACKFILL_SQL).toBe(
        'UPDATE "community_badges" SET "backfill_requested_at" = NULL WHERE "id" = ANY($1::uuid[])',
      );
    });

    it('releases the lock on the same connection', async () => {
      await service.runBackfill();

      expect(lockRunner.connect).toHaveBeenCalledTimes(1);
      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [COMMUNITY_BADGE_BACKFILL_LOCK_KEY],
      );
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });

    it('releases the lock when the transaction throws', async () => {
      transaction.mockRejectedValueOnce(new RangeError('boom'));

      await expect(service.runBackfill()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        'Community badge backfill failed: RangeError',
      );
      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [COMMUNITY_BADGE_BACKFILL_LOCK_KEY],
      );
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('runDailySweep', () => {
    it('skips badges whose backfill is still pending in the sweep', async () => {
      poolQuery.mockResolvedValueOnce([{ id: 'c1' }]);

      await service.runDailySweep();

      expect(awardCommunity).toHaveBeenCalledWith({
        communityId: 'c1',
        badgeIds: null,
        shouldNotify: true,
        onlyReadyBadges: true,
      });
      expect(collapsed(SWEEP_COMMUNITIES_PAGE_SQL)).toContain(
        '"b"."is_enabled" AND "b"."backfill_requested_at" IS NULL',
      );
    });

    it('awards without a transaction manager so the bell can be written', async () => {
      poolQuery.mockResolvedValueOnce([{ id: 'c1' }]);

      await service.runDailySweep();

      expect(transaction).not.toHaveBeenCalled();
      expect(awardCommunity.mock.calls[0]).toHaveLength(1);
    });

    it('reads only live top-level communities in id order', () => {
      const sql = collapsed(SWEEP_COMMUNITIES_PAGE_SQL);
      expect(sql).toContain('"c"."parent_id" IS NULL');
      expect(sql).toContain('"c"."archived_at" IS NULL');
      expect(sql).toContain('"c"."id" > $1');
      expect(sql).toContain('ORDER BY "c"."id" LIMIT 200');
    });

    it('sweeps top-level live communities page by page and survives one failure', async () => {
      const firstPageIds = buildCommunityIds('community-a', 200);
      const secondPageIds = buildCommunityIds('community-b', 2);
      poolQuery
        .mockResolvedValueOnce(firstPageIds.map((id) => ({ id })))
        .mockResolvedValueOnce(secondPageIds.map((id) => ({ id })));
      awardCommunity.mockImplementation((input: { communityId: string }) => {
        if (input.communityId === firstPageIds[1]) {
          return Promise.reject(new SyntaxError('detail with an id'));
        }
        return Promise.resolve(1);
      });

      await service.runDailySweep();

      expect(poolQuery).toHaveBeenCalledTimes(2);
      expect(poolQuery).toHaveBeenNthCalledWith(1, SWEEP_COMMUNITIES_PAGE_SQL, [
        SWEEP_FIRST_PAGE_AFTER_ID,
      ]);
      expect(poolQuery).toHaveBeenNthCalledWith(2, SWEEP_COMMUNITIES_PAGE_SQL, [
        firstPageIds[199],
      ]);
      expect(awardCommunity).toHaveBeenCalledTimes(202);
      expect(awardCommunity).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: firstPageIds[2] }),
      );
      expect(awardCommunity).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: secondPageIds[1] }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'Community badge sweep failed for one community: SyntaxError',
      );
      const warnedText = warnSpy.mock.calls.flat().join(' ');
      expect(warnedText).not.toContain('detail with an id');
      expect(warnedText).not.toContain(firstPageIds[1]);
      expect(logSpy).toHaveBeenCalledWith(
        'Community badge sweep: 201 communities, 201 awards, 1 failed',
      );
    });

    it('skips the run when another replica holds the lock', async () => {
      isLockFree = false;

      await service.runDailySweep();

      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [COMMUNITY_BADGE_SWEEP_LOCK_KEY],
      );
      expect(poolQuery).not.toHaveBeenCalled();
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });

    it('releases the lock on the same connection', async () => {
      await service.runDailySweep();

      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [COMMUNITY_BADGE_SWEEP_LOCK_KEY],
      );
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });
  });
});
