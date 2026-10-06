import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { GeocodeService } from '../geocode/geocode.service';
import { HousingListing } from './entities/housing-listing.entity';

/** What one geocode of a listing's private address needs to know. */
export type HousingGeocodeTarget = Pick<
  HousingListing,
  'id' | 'ref' | 'area' | 'city'
> & { addressLine: string };

/**
 * Geocodes one listing's private street address and writes the result, shared
 * by the post-save path in `HousingListingsService` and the hourly
 * `HousingListingGeocodeRetryService` (ENG-469).
 *
 * Both writes are conditional on the address STILL being the one that was
 * geocoded, so a lister who corrects their address while a lookup is in flight
 * cannot have the older result (or the older failure) land on the newer one.
 *
 * - Success stores the coordinates and returns true.
 * - "Could not place this address" (`GeocodeService` throws a 422
 *   `UnprocessableEntityException`) adds one to `geocodeAttempts` and returns
 *   false, which is how the retry sweep knows when to stop asking about an
 *   address Nominatim cannot place.
 * - Every other failure (the rate limiter's `GeocoderBusyException`, an
 *   unreachable or erroring upstream, both 503s) returns false and leaves the
 *   count alone: the address was never judged, so the next sweep asks again.
 *
 * Never rejects: every error is logged with the listing ref and swallowed. The
 * address itself is private, so it is never logged.
 */
export async function geocodeListingAddress(
  listings: Repository<HousingListing>,
  geocode: GeocodeService,
  target: HousingGeocodeTarget,
  logger: Logger,
): Promise<boolean> {
  // Nominatim resolves a bare street line far better with its neighbourhood,
  // city and country attached, and housing is Lisbon-only, so the city is a
  // real constraint on the match.
  const query = [target.addressLine, target.area, target.city, 'Portugal']
    .filter((part) => part.length > 0)
    .join(', ');
  const geocodedRow = { id: target.id, addressLine: target.addressLine };
  try {
    const point = await geocode.resolveAddress(query);
    await listings.update(geocodedRow, {
      latitude: point.latitude,
      longitude: point.longitude,
    });
    return true;
  } catch (error) {
    logger.warn(
      `Housing listing geocode failed for ${target.ref}: ${String(error)}`,
    );
    if (!(error instanceof UnprocessableEntityException)) return false;
  }
  try {
    await listings.update(geocodedRow, {
      geocodeAttempts: () => 'geocode_attempts + 1',
    });
  } catch (error) {
    logger.warn(
      `Housing listing geocode attempt count failed for ${target.ref}: ${String(error)}`,
    );
  }
  return false;
}
