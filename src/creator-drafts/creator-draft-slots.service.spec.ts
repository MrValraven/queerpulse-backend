import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CreatorDraftSlotsService } from './creator-draft-slots.service';
import { CreatorDraft } from './entities/creator-draft.entity';

describe('CreatorDraftSlotsService', () => {
  let service: CreatorDraftSlotsService;
  const drafts = { delete: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    drafts.delete.mockResolvedValue({ affected: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        CreatorDraftSlotsService,
        { provide: getRepositoryToken(CreatorDraft), useValue: drafts },
      ],
    }).compile();
    service = moduleRef.get(CreatorDraftSlotsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes the caller event slot after a publish', async () => {
    await service.discardAfterPublish('member-1', 'event');
    expect(drafts.delete).toHaveBeenCalledWith({
      userId: 'member-1',
      kind: 'event',
      slotKey: '',
    });
  });

  it('logs a failed delete without the slot contents and never throws', async () => {
    drafts.delete.mockRejectedValue(new Error('connection reset'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await expect(
      service.discardAfterPublish('member-1', 'community'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('community'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('member-1'));
  });
});
