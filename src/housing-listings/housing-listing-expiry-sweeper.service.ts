import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, Not, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import { LISTING_EXPIRY_WARNING_LEAD_MS } from './housing-listings.service';

// Rows flipped per UPDATE, bounding lock/WAL cost per batch (mirrors
// InviteExpirySweeperService.SWEEP_BATCH_SIZE).
const SWEEP_BATCH_SIZE = 500;
const SWEEP_MAX_BATCHES = 20;

/**
 * How many listings one warning tick will notify about. A ceiling rather than a
 * target (the same shape `CardExpiryWarningService.MAX_WARNINGS_PER_RUN` uses):
 * the pass is idempotent and daily, so a backlog larger than this drains over
 * the following nights instead of turning one cron tick into an unbounded
 * fan-out of notification writes.
 */
const MAX_EXPIRY_WARNINGS_PER_RUN = 500;

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
 *
 * TWO PASSES run on the midnight tick, in opposite directions on the same
 * clock. `sweepExpiredListings` looks BACKWARDS and persists the lapse that
 * has already happened. `warnExpiringListings` (PRD-244) looks FORWARDS and
 * tells the owner it is about to, while `extend` can still stop it. They share
 * the repository, the table and the index, and their windows cannot overlap,
 * so a listing is never both warned and expired on one night. Each carries its
 * own try/catch, so a failure in one still lets the other run.
 */
@Injectable()
export class HousingListingExpirySweeperService {
  private readonly logger = new Logger(HousingListingExpirySweeperService.name);

  constructor(
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    private readonly notifications: NotificationsService,
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

  /**
   * PRD-244: tell an owner their listing is about to lapse, while there is
   * still time to keep it.
   *
   * The gap this closes. Every signal the owner had was a post-mortem: the
   * "Expired" pill and the expired hint on `My listings` both only appear once
   * the home has already dropped out of public browse, and the bell said
   * nothing at all. An owner who was still looking for a flatmate found out by
   * noticing their own listing had gone quiet. The `extend` endpoint and its
   * button existed the whole time; nothing ever prompted anyone to press it.
   *
   * IN-APP. QueerPulse sends no email and never will, so nothing here is
   * described as one and no copy promises a message on any other channel.
   *
   * ## Warning once, not every morning
   *
   * This runs on the same DAILY tick as the soft-expiry sweep above and the
   * window is a week wide, so the naive version tells an owner seven times. The
   * row is CLAIMED first with a conditional UPDATE whose WHERE still carries
   * `expiry_warning_sent_at IS NULL`, the shape `CardExpiryWarningService` and
   * `AccountDeletionProcessorService.warnUpcomingDeletions` both use, so a tick
   * that loses the race sees `affected === 0` and skips. Two replicas ticking
   * at the same instant send once between them.
   *
   * Every path that gives a listing a fresh term clears the marker
   * (`HousingListingsService.extend` and `.markAvailable`, and
   * `HousingListingModerationService.decide` on an approval that refreshes a
   * stale window), so the next term earns its own warning.
   *
   * ## What is deliberately skipped
   *
   * A listing the owner already marked filled (they found someone, so a
   * countdown is telling them the wrong thing), anything not `live` (a listing
   * in review, refused, or taken down is not publicly browsable, and its owner
   * has a moderation decision to read instead of a deadline), an expiry that
   * has ALREADY passed (a warning about a moment in the past is not a warning,
   * and the expired hint on the card already says so), and a listing whose
   * `owner_id` is NULL because the lister erased their account. All four are
   * filtered BEFORE the claim, so a listing that is merely filled today still
   * gets its warning if the owner marks it available again in time.
   *
   * Errors are swallowed and logged: an escaping rejection from a
   * `@nestjs/schedule` handler becomes an unhandledRejection that can take the
   * process down, and the next tick retries.
   *
   * Query cost: `status = 'live'` is an equality on the leading column of
   * `IDX_housing_listings_status_expires_at` and the window is a range on its
   * second, so this is one bounded index range scan. The remaining predicates
   * are cheap residual filters on the rows it returns.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async warnExpiringListings(): Promise<void> {
    try {
      await this.sweepExpiringListings();
    } catch (error) {
      this.logger.error(
        `Housing listing expiry warning sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  private async sweepExpiringListings(): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + LISTING_EXPIRY_WARNING_LEAD_MS);

    const due = await this.listings.find({
      where: {
        status: HousingListingStatus.Live,
        filledAt: IsNull(),
        expiryWarningSentAt: IsNull(),
        // Two-sided on purpose. Without the lower bound the oldest already-dead
        // rows would occupy the whole batch every night and starve the listings
        // that are genuinely about to lapse, which is the bug the card sweep
        // documents at the same spot. A range is still one index scan, so the
        // bound costs nothing.
        expiresAt: Between(now, horizon),
        // NULL once the lister erased their account
        // (`SetNullContentAuthorFksOnUserErasure1794610000000`). There is no
        // recipient, so there is nothing to send.
        ownerId: Not(IsNull()),
      },
      order: { expiresAt: 'ASC' },
      take: MAX_EXPIRY_WARNINGS_PER_RUN,
    });
    if (due.length === 0) return;

    let warned = 0;
    for (const listing of due) {
      const ownerId = listing.ownerId;
      // The query proved this, but the compiler has not seen the proof and a
      // silent skip is the right answer either way.
      if (ownerId === null) continue;

      const claim = await this.listings.update(
        {
          id: listing.id,
          status: HousingListingStatus.Live,
          expiryWarningSentAt: IsNull(),
        },
        { expiryWarningSentAt: now },
      );
      if (claim.affected !== 1) continue;

      try {
        // No actor: the deadline is the listing's own clock, so there is no
        // member to name and no block/mute relationship to gate on.
        await this.notifications.create(
          ownerId,
          NotificationType.HousingListingExpiring,
          {
            source: 'housing',
            slug: listing.slug,
            title: listing.title,
            expiresAt: listing.expiresAt.toISOString(),
          },
        );
        warned += 1;
      } catch (error) {
        // The claim stands. Dropping the marker so tomorrow's tick retries
        // would reopen the daily-repeat this column exists to close, and an
        // owner who loses one warning still sees the date on their own card.
        this.logger.warn(
          `Housing listing expiry warning for ${listing.ref} was claimed but not delivered: ${String(error)}`,
        );
      }
    }
    if (warned > 0) {
      this.logger.log(`Warned ${warned} owner(s) of a listing nearing expiry`);
    }
  }
}
