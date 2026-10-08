import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { In, Not } from 'typeorm';
import { ListingCoManagerStatus } from './entities/listing-co-manager.entity';
import {
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';
import {
  ListingRunByService,
  RUN_BY_NOT_MANAGER_CODE,
} from './listing-run-by.service';

const WALK = {
  id: 'listing-walk',
  ref: 'QPL-2026-0042',
  slug: 'lisboa-a-pe',
  name: 'Lisboa a Pé',
  ownerId: 'owner-1',
};

describe('ListingRunByService', () => {
  let listings: { findOne: jest.Mock; find: jest.Mock };
  let coManagers: { exists: jest.Mock };
  let contentModeration: { statesForAnyType: jest.Mock };
  let service: ListingRunByService;

  beforeEach(() => {
    listings = {
      findOne: jest.fn().mockResolvedValue(WALK),
      find: jest.fn().mockResolvedValue([]),
    };
    coManagers = { exists: jest.fn().mockResolvedValue(false) };
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    };
    service = new ListingRunByService(
      listings as never,
      coManagers as never,
      contentModeration as never,
    );
  });

  describe('assertCanRunGatherings', () => {
    it('lets the owner name the listing and hands back its id and display ref', async () => {
      await expect(
        service.assertCanRunGatherings(WALK.id, ['owner-1']),
      ).resolves.toEqual({
        id: WALK.id,
        ref: WALK.ref,
        slug: WALK.slug,
        name: WALK.name,
      });
      expect(coManagers.exists).not.toHaveBeenCalled();
    });

    it('lets an active co-manager name it', async () => {
      coManagers.exists.mockResolvedValue(true);

      await expect(
        service.assertCanRunGatherings(WALK.id, ['co-manager-1']),
      ).resolves.toMatchObject({ id: WALK.id });
      expect(coManagers.exists).toHaveBeenCalledWith({
        where: {
          listingId: WALK.id,
          userId: 'co-manager-1',
          status: ListingCoManagerStatus.Active,
        },
      });
    });

    it('refuses a member who does not run the business with a coded 403 that names no listing', async () => {
      const failure: unknown = await service
        .assertCanRunGatherings(WALK.id, ['stranger-1'])
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenException);
      const response = (failure as ForbiddenException).getResponse();
      expect(response).toMatchObject({
        statusCode: 403,
        code: RUN_BY_NOT_MANAGER_CODE,
      });
      expect(JSON.stringify(response)).not.toContain(WALK.name);
    });

    it('needs every member it is handed to run the business', async () => {
      // The host owns it; the co-host making the edit does not.
      await expect(
        service.assertCanRunGatherings(WALK.id, ['owner-1', 'cohost-1']),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('asks once per member when the host is also the caller', async () => {
      coManagers.exists.mockResolvedValue(true);

      await service.assertCanRunGatherings(WALK.id, [
        'co-manager-1',
        'co-manager-1',
      ]);

      expect(coManagers.exists).toHaveBeenCalledTimes(1);
    });

    it('answers 400 for a listing that is unknown, still in review, paused or closed for good', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.assertCanRunGatherings('listing-gone', ['owner-1']),
      ).rejects.toThrow(new BadRequestException('Run by listing not found'));
      expect(listings.findOne).toHaveBeenCalledWith({
        where: {
          id: 'listing-gone',
          status: ListingStatus.Live,
          isHiddenByOwner: false,
          operatingState: Not(ListingOperatingState.PermanentlyClosed),
        },
      });
    });

    it('answers 400 for a listing a moderator hid or removed', async () => {
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([[WALK.slug, { hidden: true, removed: false }]]),
      );

      await expect(
        service.assertCanRunGatherings(WALK.id, ['owner-1']),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(contentModeration.statesForAnyType).toHaveBeenCalledWith(
        ['business', 'listing'],
        [WALK.slug],
      );
    });
  });

  describe('resolveForDisplay', () => {
    it('reads nothing when no gathering names a business', async () => {
      await expect(service.resolveForDisplay([])).resolves.toEqual(new Map());
      expect(listings.find).not.toHaveBeenCalled();
    });

    it('resolves each live listing its owner shows, once', async () => {
      listings.find.mockResolvedValue([WALK]);

      const refs = await service.resolveForDisplay([WALK.id, WALK.id]);

      expect(refs.get(WALK.id)).toEqual({
        ref: WALK.ref,
        slug: WALK.slug,
        name: WALK.name,
      });
      expect(listings.find).toHaveBeenCalledWith({
        where: {
          id: In([WALK.id]),
          status: ListingStatus.Live,
          isHiddenByOwner: false,
        },
        select: { id: true, ref: true, slug: true, name: true },
      });
    });

    it('leaves out a listing a moderator removed', async () => {
      listings.find.mockResolvedValue([WALK]);
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([[WALK.slug, { hidden: false, removed: true }]]),
      );

      const refs = await service.resolveForDisplay([WALK.id]);

      expect(refs.has(WALK.id)).toBe(false);
    });
  });
});
