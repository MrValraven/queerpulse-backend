import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AuthMaintenanceService } from './auth-maintenance.service';
import { RefreshToken } from './entities/refresh-token.entity';

describe('AuthMaintenanceService.purgeExpiredRefreshTokens', () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // The retention window is the configured refresh TTL, so the config stub is
  // what decides the cutoff.
  function buildConfig(refreshTtlMs = THIRTY_DAYS_MS) {
    return {
      getOrThrow: jest.fn().mockReturnValue(refreshTtlMs),
    } as unknown as ConfigService;
  }

  function buildQb(affected: number) {
    return {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    };
  }

  it('deletes rows expired OR revoked more than one refresh lifetime ago', async () => {
    const qb = buildQb(4);
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const service = new AuthMaintenanceService(
      repo as unknown as Repository<RefreshToken>,
      buildConfig(),
    );

    await service.purgeExpiredRefreshTokens();

    expect(qb.from).toHaveBeenCalledWith(RefreshToken);
    // Snake_case column names + a cutoff one refresh TTL back.
    expect(qb.where).toHaveBeenCalledWith(
      'expires_at < :cutoff',
      expect.objectContaining({ cutoff: expect.any(Date) as unknown }),
    );
    expect(qb.orWhere).toHaveBeenCalledWith(
      'revoked_at < :cutoff',
      expect.objectContaining({ cutoff: expect.any(Date) as unknown }),
    );
    expect(qb.execute).toHaveBeenCalledTimes(1);

    const whereArgs = qb.where.mock.calls[0] as [string, { cutoff: Date }];
    const { cutoff } = whereArgs[1];
    const ageMs = Date.now() - cutoff.getTime();
    // Allow a little slack for test execution time.
    expect(ageMs).toBeGreaterThanOrEqual(THIRTY_DAYS_MS - 5_000);
    expect(ageMs).toBeLessThanOrEqual(THIRTY_DAYS_MS + 5_000);
  });

  it('tracks a non-default JWT_REFRESH_TTL instead of a hardcoded 30 days', async () => {
    const qb = buildQb(1);
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const service = new AuthMaintenanceService(
      repo as unknown as Repository<RefreshToken>,
      buildConfig(sevenDaysMs),
    );

    await service.purgeExpiredRefreshTokens();

    const whereArgs = qb.where.mock.calls[0] as [string, { cutoff: Date }];
    const ageMs = Date.now() - whereArgs[1].cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(sevenDaysMs - 5_000);
    expect(ageMs).toBeLessThanOrEqual(sevenDaysMs + 5_000);
  });

  it('does not throw when there is nothing to purge', async () => {
    const qb = buildQb(0);
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const service = new AuthMaintenanceService(
      repo as unknown as Repository<RefreshToken>,
      buildConfig(),
    );
    await expect(service.purgeExpiredRefreshTokens()).resolves.toBeUndefined();
  });
});
