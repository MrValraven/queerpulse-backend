import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { And, In, IsNull, LessThan, Not } from 'typeorm';
import { GeocodeService } from '../geocode/geocode.service';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import { HousingListingGeocodeRetryService } from './housing-listing-geocode-retry.service';
import { geocodeListingAddress } from './housing-listing-geocode';

jest.mock('./housing-listing-geocode', () => ({
  geocodeListingAddress: jest.fn(),
}));

const geocodeListingAddressMock = geocodeListingAddress as jest.MockedFunction<
  typeof geocodeListingAddress
>;

function makePending(id: string, addressLine: string | null): HousingListing {
  return {
    id,
    ref: `QPH-2026-${id}`,
    addressLine,
    area: 'Arroios',
    city: 'Lisbon',
  } as HousingListing;
}

describe('HousingListingGeocodeRetryService', () => {
  let service: HousingListingGeocodeRetryService;
  let listings: { find: jest.Mock };
  let geocode: { resolveAddress: jest.Mock };

  beforeEach(async () => {
    geocodeListingAddressMock.mockReset();
    geocodeListingAddressMock.mockResolvedValue(true);
    listings = { find: jest.fn().mockResolvedValue([]) };
    geocode = { resolveAddress: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingListingGeocodeRetryService,
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: GeocodeService, useValue: geocode },
      ],
    }).compile();

    service = module.get(HousingListingGeocodeRetryService);
  });

  it('picks up to 20 reachable unpinned listings with a non-blank address and attempts left, oldest edit first', async () => {
    await service.retryFailedGeocodes();

    expect(listings.find).toHaveBeenCalledWith({
      where: {
        addressLine: And(Not(IsNull()), Not('')),
        latitude: IsNull(),
        geocodeAttempts: LessThan(5),
        status: In([
          HousingListingStatus.Live,
          HousingListingStatus.Review,
          HousingListingStatus.Question,
        ]),
      },
      order: { updatedAt: 'ASC' },
      take: 20,
    });
    expect(geocodeListingAddressMock).not.toHaveBeenCalled();
  });

  it('geocodes the listings one at a time, in the order the query returned them', async () => {
    listings.find.mockResolvedValue([
      makePending('0001', 'Rua A 1'),
      makePending('0002', 'Rua B 2'),
    ]);
    let inFlightCount = 0;
    let maxInFlightCount = 0;
    geocodeListingAddressMock.mockImplementation(async () => {
      inFlightCount += 1;
      maxInFlightCount = Math.max(maxInFlightCount, inFlightCount);
      await Promise.resolve();
      inFlightCount -= 1;
      return true;
    });

    await service.retryFailedGeocodes();

    expect(maxInFlightCount).toBe(1);
    expect(
      geocodeListingAddressMock.mock.calls.map((call) => call[2].id),
    ).toEqual(['0001', '0002']);
    expect(geocodeListingAddressMock.mock.calls[0]?.[2]).toEqual({
      id: '0001',
      ref: 'QPH-2026-0001',
      addressLine: 'Rua A 1',
      area: 'Arroios',
      city: 'Lisbon',
    });
  });

  it('still skips an empty address that reaches the loop', async () => {
    listings.find.mockResolvedValue([makePending('0001', '')]);

    await service.retryFailedGeocodes();

    expect(geocodeListingAddressMock).not.toHaveBeenCalled();
  });

  it('swallows a failing query', async () => {
    listings.find.mockRejectedValue(new Error('connection reset'));

    await expect(service.retryFailedGeocodes()).resolves.toBeUndefined();
  });

  it('swallows a geocode that rejects', async () => {
    listings.find.mockResolvedValue([makePending('0001', 'Rua A 1')]);
    geocodeListingAddressMock.mockRejectedValue(new Error('unexpected'));

    await expect(service.retryFailedGeocodes()).resolves.toBeUndefined();
  });
});
