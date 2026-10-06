import {
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { GeocodeService } from '../geocode/geocode.service';
import { GeocoderBusyException } from '../geocode/nominatim-rate-limiter';
import { HousingListing } from './entities/housing-listing.entity';
import {
  geocodeListingAddress,
  HousingGeocodeTarget,
} from './housing-listing-geocode';

const PRIVATE_ADDRESS = 'Rua Secreta 1';

const TARGET: HousingGeocodeTarget = {
  id: 'listing-1',
  ref: 'QPH-2026-0001',
  addressLine: PRIVATE_ADDRESS,
  area: 'Arroios',
  city: 'Lisbon',
};

describe('geocodeListingAddress', () => {
  let listings: { update: jest.Mock };
  let geocode: { resolveAddress: jest.Mock };
  let logger: { warn: jest.Mock };

  beforeEach(() => {
    listings = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    geocode = {
      resolveAddress: jest
        .fn()
        .mockResolvedValue({ latitude: 38.7169, longitude: -9.1487 }),
    };
    logger = { warn: jest.fn() };
  });

  function run(): Promise<boolean> {
    return geocodeListingAddress(
      listings as unknown as Repository<HousingListing>,
      geocode as unknown as GeocodeService,
      TARGET,
      logger as unknown as Logger,
    );
  }

  function loggedText(): string {
    return logger.warn.mock.calls
      .map((call: unknown[]) => call.map(String).join(' '))
      .join('\n');
  }

  it('asks the geocoder with the area, city and country attached', async () => {
    await run();

    expect(geocode.resolveAddress).toHaveBeenCalledWith(
      'Rua Secreta 1, Arroios, Lisbon, Portugal',
    );
  });

  // The write is keyed on the address that was geocoded, so a lookup that
  // finishes after the lister changed their address lands nowhere.
  it('stores the coordinates with a write keyed on the id and the geocoded address', async () => {
    const isPlaced = await run();

    expect(isPlaced).toBe(true);
    expect(listings.update).toHaveBeenCalledTimes(1);
    expect(listings.update).toHaveBeenCalledWith(
      { id: 'listing-1', addressLine: PRIVATE_ADDRESS },
      { latitude: 38.7169, longitude: -9.1487 },
    );
  });

  it('counts one attempt when the geocoder cannot place the address', async () => {
    geocode.resolveAddress.mockRejectedValue(
      new UnprocessableEntityException("Couldn't find that address"),
    );

    const isPlaced = await run();

    expect(isPlaced).toBe(false);
    expect(listings.update).toHaveBeenCalledTimes(1);
    const [criteria, values] = listings.update.mock.calls[0] as [
      unknown,
      { geocodeAttempts: () => string },
    ];
    expect(criteria).toEqual({ id: 'listing-1', addressLine: PRIVATE_ADDRESS });
    expect(values.geocodeAttempts()).toBe('geocode_attempts + 1');
  });

  // The address was never judged, so an outage must not spend its attempts.
  it('counts nothing when the rate limiter is busy', async () => {
    geocode.resolveAddress.mockRejectedValue(new GeocoderBusyException(3));

    const isPlaced = await run();

    expect(isPlaced).toBe(false);
    expect(listings.update).not.toHaveBeenCalled();
  });

  it('counts nothing when the geocoder cannot be reached', async () => {
    geocode.resolveAddress.mockRejectedValue(
      new ServiceUnavailableException("Couldn't reach the address geocoder."),
    );

    const isPlaced = await run();

    expect(isPlaced).toBe(false);
    expect(listings.update).not.toHaveBeenCalled();
  });

  it('resolves false when the coordinate write itself fails', async () => {
    listings.update.mockRejectedValue(new Error('connection reset'));

    await expect(run()).resolves.toBe(false);
  });

  it('resolves false when counting the attempt fails', async () => {
    geocode.resolveAddress.mockRejectedValue(
      new UnprocessableEntityException("Couldn't find that address"),
    );
    listings.update.mockRejectedValue(new Error('connection reset'));

    await expect(run()).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs the listing ref and keeps the private address out of every log line', async () => {
    geocode.resolveAddress.mockRejectedValue(
      new UnprocessableEntityException("Couldn't find that address"),
    );
    listings.update.mockRejectedValue(new Error('connection reset'));

    await run();

    const logged = loggedText();
    expect(logged).toContain('QPH-2026-0001');
    expect(logged).not.toContain(PRIVATE_ADDRESS);
  });
});
