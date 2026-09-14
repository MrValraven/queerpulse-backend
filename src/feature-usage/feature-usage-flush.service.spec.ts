import { FeatureUsageFlushService } from './feature-usage-flush.service';
import { FeatureUsageTallyService } from './feature-usage-tally.service';

describe('FeatureUsageFlushService', () => {
  let tally: FeatureUsageTallyService;
  let query: jest.Mock;
  let service: FeatureUsageFlushService;

  beforeEach(() => {
    tally = new FeatureUsageTallyService();
    query = jest.fn().mockResolvedValue(undefined);
    service = new FeatureUsageFlushService({ query } as never, tally);
  });

  it('writes nothing when no requests arrived', async () => {
    await service.flushPendingCounts();
    expect(query).not.toHaveBeenCalled();
  });

  it('upserts one statement per tallied feature', async () => {
    tally.record('forum');
    tally.record('forum');
    tally.record('housing');
    await service.flushPendingCounts();
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT ("day", "feature_key")');
    expect(sql).toContain('request_count" + EXCLUDED."request_count"');
    expect(parameters[1]).toBe('forum');
    expect(parameters[2]).toBe(2);
  });

  it('restores the tally when the write fails, so counts are not lost', async () => {
    query.mockRejectedValue(new Error('connection reset'));
    tally.record('magazine');
    await service.flushPendingCounts();
    expect(tally.drain().get('magazine')).toBe(1);
  });

  it('restores only the key that was not written when a later statement fails', async () => {
    query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('connection reset'));
    tally.record('forum');
    tally.record('housing');
    await service.flushPendingCounts();
    const remainingCounts = tally.drain();
    expect(remainingCounts.has('forum')).toBe(false);
    expect(remainingCounts.get('housing')).toBe(1);
    expect(remainingCounts.size).toBe(1);
  });
});
