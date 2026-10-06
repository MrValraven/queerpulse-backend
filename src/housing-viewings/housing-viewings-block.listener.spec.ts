import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import {
  HousingViewing,
  HousingViewingStatus,
} from './entities/housing-viewing.entity';
import { HousingViewingsBlockListener } from './housing-viewings-block.listener';

/**
 * ENG-467 / ENG-468. A block cancels the open viewings between the pair in
 * both directions. Each direction is its own UPDATE with a single where
 * object: the app runs TypeORM with `invalidWhereValuesBehavior`, which throws
 * on an array criteria, so a combined call would cancel nothing.
 */
describe('HousingViewingsBlockListener', () => {
  let listener: HousingViewingsBlockListener;
  let viewings: { update: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const OPEN_STATUSES = In([
    HousingViewingStatus.Requested,
    HousingViewingStatus.Accepted,
  ]);

  beforeEach(async () => {
    viewings = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HousingViewingsBlockListener,
        { provide: getRepositoryToken(HousingViewing), useValue: viewings },
      ],
    }).compile();

    listener = moduleRef.get(HousingViewingsBlockListener);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('cancels the open viewings in each direction with one single-object update apiece', async () => {
    await listener.handleMemberBlocked({
      blockerId: 'lister-1',
      blockedId: 'guest-1',
    });

    expect(viewings.update).toHaveBeenCalledTimes(2);
    expect(viewings.update).toHaveBeenNthCalledWith(
      1,
      { requesterId: 'lister-1', listerId: 'guest-1', status: OPEN_STATUSES },
      { status: HousingViewingStatus.Cancelled },
    );
    expect(viewings.update).toHaveBeenNthCalledWith(
      2,
      { requesterId: 'guest-1', listerId: 'lister-1', status: OPEN_STATUSES },
      { status: HousingViewingStatus.Cancelled },
    );
    for (const [criteria] of viewings.update.mock.calls as [unknown][]) {
      expect(Array.isArray(criteria)).toBe(false);
    }
  });

  it('logs a failed direction and still runs the other one', async () => {
    viewings.update
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ affected: 1 });

    await expect(
      listener.handleMemberBlocked({
        blockerId: 'lister-1',
        blockedId: 'guest-1',
      }),
    ).resolves.toBeUndefined();

    expect(viewings.update).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection reset'),
    );
  });

  it('ignores a self-block', async () => {
    await listener.handleMemberBlocked({
      blockerId: 'guest-1',
      blockedId: 'guest-1',
    });

    expect(viewings.update).not.toHaveBeenCalled();
  });
});
