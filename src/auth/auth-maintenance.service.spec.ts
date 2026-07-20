import { Repository } from 'typeorm';
import { AuthMaintenanceService } from './auth-maintenance.service';
import { RefreshToken } from './entities/refresh-token.entity';

describe('AuthMaintenanceService.purgeExpiredRefreshTokens', () => {
  function buildQb(affected: number) {
    return {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    };
  }

  it('deletes rows expired OR revoked more than 30 days ago', async () => {
    const qb = buildQb(4);
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const service = new AuthMaintenanceService(
      repo as unknown as Repository<RefreshToken>,
    );

    await service.purgeExpiredRefreshTokens();

    expect(qb.from).toHaveBeenCalledWith(RefreshToken);
    // Snake_case column names + a ~30-day cutoff.
    expect(qb.where).toHaveBeenCalledWith(
      'expires_at < :cutoff',
      expect.objectContaining({ cutoff: expect.any(Date) }),
    );
    expect(qb.orWhere).toHaveBeenCalledWith(
      'revoked_at < :cutoff',
      expect.objectContaining({ cutoff: expect.any(Date) }),
    );
    expect(qb.execute).toHaveBeenCalledTimes(1);

    const { cutoff } = qb.where.mock.calls[0][1] as { cutoff: Date };
    const ageMs = Date.now() - cutoff.getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    // Allow a little slack for test execution time.
    expect(ageMs).toBeGreaterThanOrEqual(thirtyDaysMs - 5_000);
    expect(ageMs).toBeLessThanOrEqual(thirtyDaysMs + 5_000);
  });

  it('does not throw when there is nothing to purge', async () => {
    const qb = buildQb(0);
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const service = new AuthMaintenanceService(
      repo as unknown as Repository<RefreshToken>,
    );
    await expect(service.purgeExpiredRefreshTokens()).resolves.toBeUndefined();
  });
});
