import { FeatureUsageRetentionService } from './feature-usage-retention.service';

describe('FeatureUsageRetentionService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes rows older than the configured window and keeps newer ones', async () => {
    const remove = jest.fn().mockResolvedValue({ affected: 4 });
    const config = { get: jest.fn().mockReturnValue(730) };
    const service = new FeatureUsageRetentionService(
      {
        createQueryBuilder: () => ({
          delete: () => ({
            from: () => ({
              where: (clause: string, parameters: { cutoff: string }) => ({
                execute: () => remove(clause, parameters),
              }),
            }),
          }),
        }),
      } as never,
      config as never,
    );

    const frozenNow = new Date('2026-09-14T00:00:00Z').getTime();
    jest.useFakeTimers().setSystemTime(frozenNow);

    await service.purgeOldUsageRows();

    const [clause, parameters] = remove.mock.calls[0] as [
      string,
      { cutoff: string },
    ];
    expect(clause).toContain('day < :cutoff');
    expect(parameters.cutoff).toBe('2024-09-14');
  });

  it('swallows and logs a failure so the scheduler cannot crash the process', async () => {
    const config = { get: jest.fn().mockReturnValue(730) };
    const service = new FeatureUsageRetentionService(
      {
        createQueryBuilder: () => {
          throw new Error('connection reset');
        },
      } as never,
      config as never,
    );
    await expect(service.purgeOldUsageRows()).resolves.toBeUndefined();
  });
});
