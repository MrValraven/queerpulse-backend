import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';

// Rows flipped per UPDATE, bounding lock/WAL cost per batch (mirrors
// InviteExpirySweeperService.SWEEP_BATCH_SIZE).
const SWEEP_BATCH_SIZE = 500;
const SWEEP_MAX_BATCHES = 20;

/**
 * HSG-3: daily sweep that withholds a housing listing from public browse once
 * its `expiresAt` has passed, by setting `filledAt` (the same field an owner
 * sets via `mark-filled`) — never a hard delete, and the owner can always
 * bring it back with `mark-available` (which also refreshes `expiresAt` when
 * it's the one that's stale) or extend it first with `extend`.
 *
 * This is a defence-in-depth backstop, not the only enforcement: both
 * `HousingDirectoryService.browse` and `.detail` already filter/withhold on
 * `expires_at > now()` directly, so a stale listing never actually appears in
 * public browse even on the day before this sweep gets to it. What the sweep
 * adds is a PERSISTED state: the owner's `GET /housing-listings/mine` list and
 * the moderator admin list can show "expired" as a stored fact rather than
 * recomputing it, and a listing that's merely near-expiry doesn't need a
 * write at all until it actually lapses.
 *
 * Idempotent, batched, and cheap — mirrors `InviteExpirySweeperService`
 * verbatim: only ever touches rows still `live` AND not already filled AND
 * already past `expiresAt`, in bounded batches, and swallows/logs errors so a
 * DB blip can't crash the process (an escaping rejection from a
 * `@nestjs/schedule` handler becomes an unhandledRejection).
 */
@Injectable()
export class HousingListingExpirySweeperService {
  private readonly logger = new Logger(HousingListingExpirySweeperService.name);

  constructor(
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async sweepExpiredListings(): Promise<void> {
    try {
      const now = new Date();
      const tableName = this.listings.metadata.tableName;
      let totalExpired = 0;
      for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
        // Bound each UPDATE with a primary-key subselect + LIMIT (the same
        // shape `InviteExpirySweeperService` and `deleteInBatches` use) so we
        // never lock the whole table at once.
        const result = await this.listings
          .createQueryBuilder()
          .update(HousingListing)
          .set({ filledAt: now })
          .where(
            `id IN (SELECT id FROM "${tableName}" ` +
              `WHERE status = :live AND filled_at IS NULL ` +
              `AND expires_at < :now LIMIT :limit)`,
            {
              live: HousingListingStatus.Live,
              now,
              limit: SWEEP_BATCH_SIZE,
            },
          )
          .execute();
        const affected = result.affected ?? 0;
        totalExpired += affected;
        if (affected < SWEEP_BATCH_SIZE) {
          break;
        }
      }
      if (totalExpired > 0) {
        this.logger.log(
          `Soft-expired ${totalExpired} overdue housing listing(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Housing listing expiry sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }
}
