import {
  IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY,
  IdentityMailboxReconciliationService,
} from './identity-mailbox-reconciliation.service';
import { MailboxSweepPageResult } from './identity-mailbox-sync.service';

/**
 * The hourly mailbox reconciliation: one replica at a time through a
 * session-level advisory lock on a dedicated query runner, one run per
 * process, paging until the sweep reports no more identities, and never
 * letting a failure escape the `@Cron` handler.
 */

function pageResult(
  overrides: Partial<MailboxSweepPageResult> = {},
): MailboxSweepPageResult {
  return {
    processedIdentityCount: 0,
    failedIdentityCount: 0,
    seatedMemberCount: 0,
    endedSeatCount: 0,
    lastIdentityId: null,
    hasMoreIdentities: false,
    ...overrides,
  };
}

function build(options: { isLockFree?: boolean } = {}) {
  const isLockFree = options.isLockFree ?? true;
  const lockRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ locked: isLockFree }]);
      }
      if (sql.includes('pg_advisory_unlock')) {
        return Promise.resolve([{ pg_advisory_unlock: true }]);
      }
      return Promise.reject(new Error(`Unmodelled query: ${sql}`));
    }),
  };
  const dataSource = { createQueryRunner: jest.fn(() => lockRunner) };
  const mailboxSync = {
    resyncNonProfileIdentitiesPage: jest.fn().mockResolvedValue(pageResult()),
  };
  const service = new IdentityMailboxReconciliationService(
    dataSource as never,
    mailboxSync as never,
  );
  const logger = (
    service as unknown as {
      logger: { log: jest.Mock; error: jest.Mock; debug: jest.Mock };
    }
  ).logger;
  const loggerLog = jest
    .spyOn(logger, 'log')
    .mockImplementation(() => undefined);
  const loggerError = jest
    .spyOn(logger, 'error')
    .mockImplementation(() => undefined);
  jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
  return {
    service,
    lockRunner,
    dataSource,
    mailboxSync,
    loggerLog,
    loggerError,
  };
}

function unlockCalls(lockRunner: ReturnType<typeof build>['lockRunner']) {
  return lockRunner.query.mock.calls.filter(([sql]) =>
    sql.includes('pg_advisory_unlock'),
  );
}

describe('IdentityMailboxReconciliationService', () => {
  it('uses a lock key no other advisory lock in the codebase uses', () => {
    // `MIGRATION_LOCK_KEY` and the cinema sweep's key, and above the 32-bit
    // range every `hashtext(...)` lock key falls in.
    expect(IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY).not.toBe(481205733107400);
    expect(IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY).not.toBe(793640001);
    expect(IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY).toBeGreaterThan(
      2 ** 31 - 1,
    );
    expect(Number.isSafeInteger(IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY)).toBe(
      true,
    );
  });

  it('skips the run when another replica holds the lock, and still releases the runner', async () => {
    const { service, lockRunner, mailboxSync } = build({ isLockFree: false });

    await service.handleHourlyReconciliation();

    expect(lockRunner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY],
    );
    expect(mailboxSync.resyncNonProfileIdentitiesPage).not.toHaveBeenCalled();
    // A lock it never took is never unlocked.
    expect(unlockCalls(lockRunner)).toHaveLength(0);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('pages through every identity under the lock, then logs one summary line and unlocks', async () => {
    const { service, lockRunner, mailboxSync, loggerLog } = build();
    mailboxSync.resyncNonProfileIdentitiesPage
      .mockResolvedValueOnce(
        pageResult({
          processedIdentityCount: 200,
          seatedMemberCount: 2,
          endedSeatCount: 5,
          lastIdentityId: 'identity-200',
          hasMoreIdentities: true,
        }),
      )
      .mockResolvedValueOnce(
        pageResult({
          processedIdentityCount: 37,
          failedIdentityCount: 1,
          endedSeatCount: 1,
          lastIdentityId: 'identity-237',
          hasMoreIdentities: false,
        }),
      );

    await service.handleHourlyReconciliation();

    expect(mailboxSync.resyncNonProfileIdentitiesPage).toHaveBeenCalledTimes(2);
    expect(mailboxSync.resyncNonProfileIdentitiesPage).toHaveBeenNthCalledWith(
      1,
      null,
    );
    expect(mailboxSync.resyncNonProfileIdentitiesPage).toHaveBeenNthCalledWith(
      2,
      'identity-200',
    );
    expect(loggerLog).toHaveBeenCalledTimes(1);
    expect(loggerLog).toHaveBeenCalledWith(
      'Mailbox reconciliation: 237 identities processed, 2 members seated, 6 seats ended, 1 failures',
    );
    expect(unlockCalls(lockRunner)).toEqual([
      [
        'SELECT pg_advisory_unlock($1)',
        [IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY],
      ],
    ]);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('stops paging when the cursor does not move forward', async () => {
    const { service, mailboxSync } = build();
    mailboxSync.resyncNonProfileIdentitiesPage.mockResolvedValue(
      pageResult({
        processedIdentityCount: 1,
        lastIdentityId: 'identity-1',
        hasMoreIdentities: true,
      }),
    );

    const summary = await service.reconcileAllMailboxes();

    // First page from null to identity-1, second page stuck on identity-1.
    expect(mailboxSync.resyncNonProfileIdentitiesPage).toHaveBeenCalledTimes(2);
    expect(summary.pageCount).toBe(2);
  });

  it('never lets a failed run reject, and releases the lock and the runner', async () => {
    const { service, lockRunner, mailboxSync, loggerError } = build();
    mailboxSync.resyncNonProfileIdentitiesPage.mockRejectedValue(
      new Error('database went away'),
    );

    await expect(service.handleHourlyReconciliation()).resolves.toBeUndefined();

    expect(unlockCalls(lockRunner)).toHaveLength(1);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]?.[0]).toContain('database went away');
  });

  it('releases the runner and does not reject when it cannot connect', async () => {
    const { service, lockRunner, mailboxSync, loggerError } = build();
    lockRunner.connect.mockRejectedValue(new Error('pool exhausted'));

    await expect(service.handleHourlyReconciliation()).resolves.toBeUndefined();

    expect(mailboxSync.resyncNonProfileIdentitiesPage).not.toHaveBeenCalled();
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it('skips a tick that lands while the previous run in this process is still going', async () => {
    const { service, dataSource, mailboxSync } = build();
    let finishFirstPage: (result: MailboxSweepPageResult) => void = () =>
      undefined;
    mailboxSync.resyncNonProfileIdentitiesPage.mockImplementationOnce(
      () =>
        new Promise<MailboxSweepPageResult>((resolve) => {
          finishFirstPage = resolve;
        }),
    );

    const firstRun = service.handleHourlyReconciliation();
    // Let the first run reach its first page.
    await new Promise((resolve) => setImmediate(resolve));
    await service.handleHourlyReconciliation();

    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1);

    finishFirstPage(pageResult());
    await firstRun;

    // The flag is cleared once the run ends, so the next tick runs.
    await service.handleHourlyReconciliation();
    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(2);
  });
});
