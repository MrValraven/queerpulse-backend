import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProfileLastActive } from './entities/profile-last-active.entity';
import { ActivityBand } from './last-active';
import { LastActiveService } from './last-active.service';

type RepoMock = {
  query: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
};

async function buildService(): Promise<{
  service: LastActiveService;
  repo: RepoMock;
}> {
  const repo: RepoMock = {
    query: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      LastActiveService,
      { provide: getRepositoryToken(ProfileLastActive), useValue: repo },
    ],
  }).compile();
  return { service: module.get(LastActiveService), repo };
}

/** The `[sql, parameters]` of the nth call to the repository's raw query. */
function callAt(repo: RepoMock, index: number): [string, unknown[]] {
  const call = repo.query.mock.calls[index] as [string, unknown[]];
  return call;
}

describe('LastActiveService.recordActivity', () => {
  const MEMBER = '11111111-1111-1111-1111-111111111111';
  const OTHER_MEMBER = '22222222-2222-2222-2222-222222222222';

  it('writes the coarsened month, never the instant it was handed', async () => {
    const { service, repo } = await buildService();
    await service.recordActivity(MEMBER, new Date('2026-08-25T22:41:07.913Z'));

    expect(repo.query).toHaveBeenCalledTimes(1);
    const [, parameters] = callAt(repo, 0);
    expect(parameters).toEqual([MEMBER, '2026-08-01']);
    // Nothing finer than the month may reach the database. If a day or a time
    // ever appears in these parameters, the feature has become a last-seen log.
    expect(JSON.stringify(parameters)).not.toContain('22:41');
    expect(JSON.stringify(parameters)).not.toContain('2026-08-25');
  });

  it('guards the write in SQL so an unchanged month costs nothing', async () => {
    const { service, repo } = await buildService();
    await service.recordActivity(MEMBER, new Date('2026-08-25T10:00:00.000Z'));

    const [sql] = callAt(repo, 0);
    expect(sql).toContain('ON CONFLICT');
    // The `WHERE ... IS DISTINCT FROM` on the DO UPDATE is what makes the
    // steady state a genuine no-op: same month in, no row version out.
    expect(sql).toContain('IS DISTINCT FROM');
  });

  it('runs at most once a day for the same member', async () => {
    const { service, repo } = await buildService();
    await service.recordActivity(MEMBER, new Date('2026-08-25T06:00:00.000Z'));
    await service.recordActivity(MEMBER, new Date('2026-08-25T06:00:01.000Z'));
    await service.recordActivity(MEMBER, new Date('2026-08-25T13:20:00.000Z'));
    await service.recordActivity(MEMBER, new Date('2026-08-25T23:59:59.999Z'));

    // Four session refreshes, one statement. A member with the app open in
    // several tabs rotates their cookie many times an hour.
    expect(repo.query).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next UTC day', async () => {
    const { service, repo } = await buildService();
    await service.recordActivity(MEMBER, new Date('2026-08-25T23:59:59.999Z'));
    await service.recordActivity(MEMBER, new Date('2026-08-26T00:00:00.000Z'));

    expect(repo.query).toHaveBeenCalledTimes(2);
    // Still the same month, so the second statement is the one the SQL guard
    // turns into a no-op rather than a write.
    expect(callAt(repo, 1)[1]).toEqual([MEMBER, '2026-08-01']);
  });

  it('carries the new month over a month boundary', async () => {
    const { service, repo } = await buildService();
    await service.recordActivity(MEMBER, new Date('2026-08-31T12:00:00.000Z'));
    await service.recordActivity(MEMBER, new Date('2026-09-01T12:00:00.000Z'));

    expect(callAt(repo, 0)[1]).toEqual([MEMBER, '2026-08-01']);
    expect(callAt(repo, 1)[1]).toEqual([MEMBER, '2026-09-01']);
  });

  it('throttles per member, not globally', async () => {
    const { service, repo } = await buildService();
    const at = new Date('2026-08-25T06:00:00.000Z');
    await service.recordActivity(MEMBER, at);
    await service.recordActivity(OTHER_MEMBER, at);
    await service.recordActivity(MEMBER, at);

    expect(repo.query).toHaveBeenCalledTimes(2);
    expect(callAt(repo, 0)[1][0]).toBe(MEMBER);
    expect(callAt(repo, 1)[1][0]).toBe(OTHER_MEMBER);
  });

  it('claims the day before awaiting, so refreshes racing in one tick collapse', async () => {
    const { service, repo } = await buildService();
    let release: (() => void) | undefined;
    repo.query.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const at = new Date('2026-08-25T06:00:00.000Z');

    const first = service.recordActivity(MEMBER, at);
    const second = service.recordActivity(MEMBER, at);
    release?.();
    await Promise.all([first, second]);

    expect(repo.query).toHaveBeenCalledTimes(1);
  });

  it('never lets a write failure surface to the session refresh', async () => {
    const { service, repo } = await buildService();
    repo.query.mockRejectedValue(new Error('connection terminated'));

    await expect(
      service.recordActivity(MEMBER, new Date('2026-08-25T06:00:00.000Z')),
    ).resolves.toBeUndefined();
  });

  it('releases the day after a failure so the next refresh retries', async () => {
    const { service, repo } = await buildService();
    repo.query.mockRejectedValueOnce(new Error('connection terminated'));
    const at = new Date('2026-08-25T06:00:00.000Z');

    await service.recordActivity(MEMBER, at);
    await service.recordActivity(MEMBER, at);

    // A transient failure must not suppress the member's whole day.
    expect(repo.query).toHaveBeenCalledTimes(2);
  });
});

describe('LastActiveService reads', () => {
  const MEMBER = '11111111-1111-1111-1111-111111111111';
  const now = new Date('2026-08-25T12:00:00.000Z');

  it('reads a member with no row as no band and not hidden', async () => {
    const { service } = await buildService();
    await expect(service.getSignal(MEMBER, now)).resolves.toEqual({
      band: null,
      isHidden: false,
    });
  });

  it('collapses the stored month into a band', async () => {
    const { service, repo } = await buildService();
    repo.findOne.mockResolvedValue({
      userId: MEMBER,
      lastActiveMonth: '2026-06-01',
      isHidden: false,
    });
    await expect(service.getSignal(MEMBER, now)).resolves.toEqual({
      band: ActivityBand.LastThreeMonths,
      isHidden: false,
    });
  });

  it('batches a whole directory page into one query and omits members with no row', async () => {
    const { service, repo } = await buildService();
    repo.find.mockResolvedValue([
      { userId: MEMBER, lastActiveMonth: '2026-08-01', isHidden: true },
    ]);

    const signals = await service.getSignals([MEMBER, 'absent-member'], now);

    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(signals.get(MEMBER)).toEqual({
      band: ActivityBand.ThisMonth,
      isHidden: true,
    });
    expect(signals.has('absent-member')).toBe(false);
  });

  it('asks nothing of the database for an empty page', async () => {
    const { service, repo } = await buildService();
    await expect(service.getSignals([], now)).resolves.toEqual(new Map());
    expect(repo.find).not.toHaveBeenCalled();
  });
});

describe('LastActiveService.setHidden', () => {
  const MEMBER = '11111111-1111-1111-1111-111111111111';
  const now = new Date('2026-08-25T12:00:00.000Z');

  it('stores the preference against a coarsened month, never an instant', async () => {
    const { service, repo } = await buildService();
    repo.findOne.mockResolvedValue({
      userId: MEMBER,
      lastActiveMonth: '2026-08-01',
      isHidden: true,
    });

    const signal = await service.setHidden(MEMBER, true, now);

    expect(callAt(repo, 0)[1]).toEqual([MEMBER, '2026-08-01', true]);
    expect(signal).toEqual({ band: ActivityBand.ThisMonth, isHidden: true });
  });
});
