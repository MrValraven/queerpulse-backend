import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { deleteInBatches } from '../common/batched-delete';
import { CreatorDraftRetentionService } from './creator-draft-retention.service';
import { DEFAULT_CREATOR_DRAFT_RETENTION_DAYS } from './creator-drafts.constants';
import { CreatorDraft } from './entities/creator-draft.entity';

jest.mock('../common/batched-delete');

describe('CreatorDraftRetentionService', () => {
  const drafts = {} as Repository<CreatorDraft>;
  const config = {
    get: jest.fn((_key: string, fallback: number) => fallback),
  };
  let service: CreatorDraftRetentionService;

  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockImplementation((_key: string, fallback: number) => fallback);
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T02:00:00Z'));
    service = new CreatorDraftRetentionService(
      drafts,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes expired rows, then listing edits whose listing is gone', async () => {
    const deleteInBatchesMock = jest
      .mocked(deleteInBatches)
      .mockResolvedValue(3);
    await service.purgeExpiredCreatorDrafts();
    expect(deleteInBatchesMock).toHaveBeenNthCalledWith(
      1,
      drafts,
      'updated_at < :cutoff',
      { cutoff: new Date('2026-07-21T02:00:00Z') },
      { batchSize: 1000, maxBatches: 50 },
    );
    expect(deleteInBatchesMock).toHaveBeenNthCalledWith(
      2,
      drafts,
      "kind = 'listing_edit' AND made_for_listing_id IS NULL",
      {},
      { batchSize: 1000, maxBatches: 50 },
    );
  });

  it('falls back to the shared default retention window', async () => {
    jest.mocked(deleteInBatches).mockResolvedValue(0);
    await service.purgeExpiredCreatorDrafts();
    expect(config.get).toHaveBeenCalledWith(
      'retention.creatorDraftDays',
      DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
    );
  });

  it('reads the window from config', async () => {
    config.get.mockImplementation((key: string, fallback: number) =>
      key === 'retention.creatorDraftDays' ? 30 : fallback,
    );
    jest.mocked(deleteInBatches).mockResolvedValue(0);
    await service.purgeExpiredCreatorDrafts();
    expect(jest.mocked(deleteInBatches).mock.calls[0]?.[2]).toEqual({
      cutoff: new Date('2026-09-19T02:00:00Z'),
    });
  });

  it('swallows and logs a failure so the scheduler cannot crash the process', async () => {
    jest
      .mocked(deleteInBatches)
      .mockRejectedValue(new Error('connection reset'));
    await expect(service.purgeExpiredCreatorDrafts()).resolves.toBeUndefined();
  });
});
