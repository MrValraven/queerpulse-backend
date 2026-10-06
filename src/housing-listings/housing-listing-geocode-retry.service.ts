import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { And, In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { GeocodeService } from '../geocode/geocode.service';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import { geocodeListingAddress } from './housing-listing-geocode';

/** Listings retried per tick. Each one is an outbound Nominatim call behind
 * the process-wide one-per-second gate, so a small batch keeps the tick short
 * and leaves the gate free for members who are posting right now. */
const RETRY_BATCH_SIZE = 20;

/** After this many failed geocodes of one address the sweep stops asking. An
 * address change resets the count, so a lister who fixes a typo gets a fresh
 * set of attempts. */
const MAX_GEOCODE_ATTEMPTS = 5;

/**
 * ENG-469: retries the private-address geocode that failed when the listing
 * was saved.
 *
 * `HousingListingsService` geocodes an address once, off the request path, and
 * a timeout, a saturated rate limiter or a Nominatim outage used to leave the
 * listing at area precision for good. This hourly sweep picks up every listing
 * that has an address on file, null coordinates and fewer than
 * `MAX_GEOCODE_ATTEMPTS` failures, oldest edit first, and tries again one at a
 * time. Each counted failure bumps `updatedAt`, so a stubborn address moves to
 * the back of the queue and cannot starve the rest. A busy or unreachable
 * geocoder counts nothing (see `geocodeListingAddress`), so an outage spends
 * none of a listing's attempts.
 *
 * Only listings a reader can still reach are retried: live, in review, or sent
 * back for changes. A refused or taken-down listing waits until an edit brings
 * it back to review. Soft-deleted rows are skipped by the `find` itself.
 *
 * Runs on every replica. The conditional write in `geocodeListingAddress` and
 * the process-wide Nominatim limiter bound what a duplicate pass can cost: at
 * worst one extra lookup and one extra attempt counted.
 *
 * Errors are swallowed and logged: an escaping rejection from a
 * `@nestjs/schedule` handler becomes an unhandledRejection, and the next tick
 * retries anyway.
 */
@Injectable()
export class HousingListingGeocodeRetryService {
  private readonly logger = new Logger(HousingListingGeocodeRetryService.name);

  constructor(
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    private readonly geocode: GeocodeService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async retryFailedGeocodes(): Promise<void> {
    try {
      const pending = await this.listings.find({
        where: {
          // A blank address is skipped without bumping `updatedAt`, so it
          // would hold its place at the head of the oldest-first window for
          // good. Excluding it here keeps every slot for a real address.
          addressLine: And(Not(IsNull()), Not('')),
          latitude: IsNull(),
          geocodeAttempts: LessThan(MAX_GEOCODE_ATTEMPTS),
          status: In([
            HousingListingStatus.Live,
            HousingListingStatus.Review,
            HousingListingStatus.Question,
          ]),
        },
        order: { updatedAt: 'ASC' },
        take: RETRY_BATCH_SIZE,
      });
      let placedCount = 0;
      for (const listing of pending) {
        const addressLine = listing.addressLine;
        if (addressLine === null || addressLine.length === 0) continue;
        const isPlaced = await geocodeListingAddress(
          this.listings,
          this.geocode,
          {
            id: listing.id,
            ref: listing.ref,
            addressLine,
            area: listing.area,
            city: listing.city,
          },
          this.logger,
        );
        if (isPlaced) placedCount += 1;
      }
      if (placedCount > 0) {
        this.logger.log(
          `Placed ${placedCount} housing listing address(es) on retry`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Housing listing geocode retry failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }
}
