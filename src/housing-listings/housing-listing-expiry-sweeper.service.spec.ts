import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HousingListing } from './entities/housing-listing.entity';
import { HousingListingExpirySweeperService } from './housing-listing-expiry-sweeper.service';

describe('HousingListingExpirySweeperService', () => {
  let service: HousingListingExpirySweeperService;
  let updateBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let listings: {
    metadata: { tableName: string };
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
  };
  let viewings: { closeRequestedForListings: jest.Mock };

  beforeEach(async () => {
    updateBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
    };
    for (const step of [
      updateBuilder.update,
      updateBuilder.set,
      updateBuilder.where,
      updateBuilder.returning,
    ]) {
      step.mockReturnValue(updateBuilder);
    }
    listings = {
      metadata: { tableName: 'housing_listings' },
      createQueryBuilder: jest.fn(() => updateBuilder),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    viewings = {
      closeRequestedForListings: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HousingListingExpirySweeperService,
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: HousingViewingsService, useValue: viewings },
      ],
    }).compile();
    service = moduleRef.get(HousingListingExpirySweeperService);
  });

  describe('sweepExpiredListings', () => {
    // PRD-444: the marker lands in the same write as the fill, so the owner
    // surfaces never infer a sweep from timestamps.
    it('stamps filledAt and sweptAt together and returns the swept ids', async () => {
      updateBuilder.execute.mockResolvedValue({
        raw: [{ id: 'listing-1' }, { id: 'listing-2' }],
        affected: 2,
      });

      await service.sweepExpiredListings();

      const [values] = updateBuilder.set.mock.calls[0] as [
        { filledAt: Date; sweptAt: Date },
      ];
      expect(values.filledAt).toBeInstanceOf(Date);
      expect(values.sweptAt).toBe(values.filledAt);
      expect(updateBuilder.returning).toHaveBeenCalledWith(['id']);
    });

    // A hidden home cannot accept a viewing, so its requested ones are called
    // off with a bell.
    it('closes the requested viewings on the homes it just hid', async () => {
      updateBuilder.execute.mockResolvedValue({
        raw: [{ id: 'listing-1' }, { id: 'listing-2' }],
        affected: 2,
      });

      await service.sweepExpiredListings();

      expect(viewings.closeRequestedForListings).toHaveBeenCalledTimes(1);
      expect(viewings.closeRequestedForListings).toHaveBeenCalledWith([
        'listing-1',
        'listing-2',
      ]);
    });

    it('skips the viewing pass when nothing lapsed', async () => {
      await service.sweepExpiredListings();

      expect(viewings.closeRequestedForListings).not.toHaveBeenCalled();
    });

    it('logs a failed sweep and resolves', async () => {
      updateBuilder.execute.mockRejectedValue(new Error('connection reset'));

      await expect(service.sweepExpiredListings()).resolves.toBeUndefined();
      expect(viewings.closeRequestedForListings).not.toHaveBeenCalled();
    });
  });
});
