import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import * as Sentry from '@sentry/node';
import { Repository } from 'typeorm';
import { presentActorIds } from '../common/nullable-actor';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HOUSING_LISTING_WENT_LIVE,
  HousingListingWentLiveEvent,
} from '../housing-listings/housing-listing.events';
import { HousingSavedSearch } from './entities/housing-saved-search.entity';
import { matchesHousingCriteria } from './housing-search-criteria';

/**
 * When a housing listing goes live, alerts members whose saved search (with
 * alerts on) matches it — through the EXISTING notifications system, never a
 * new delivery path. The in-app bell + realtime socket push come for free from
 * `NotificationsService.createForRecipients` (it announces every persisted
 * row); the phone push is added by `PushNotificationListener`'s whitelist.
 *
 * Efficiency (BE-HSG-11). This used to be `find({ where: { alertsEnabled: true } })`
 * with no `take` and no criteria predicate: every alerts-enabled saved search on
 * the platform was materialised and hydrated as an entity on every approval, at
 * a cap of 25 searches per member. At 10k members that is up to 250k rows
 * materialised per moderator click, on the same event loop that serves every
 * other request.
 *
 * Two changes:
 *  - The two cheap, indexable criteria are pushed into SQL as jsonb predicates:
 *    a search that pins a DIFFERENT city or a DIFFERENT type can never match
 *    this listing, so it is never loaded. Searches that leave a knob unset (or
 *    set it empty) still match anything and are still loaded, which is correct.
 *  - The remaining rows are streamed in keyset batches rather than one
 *    unbounded result set, and `createForRecipients` is called per chunk instead
 *    of once with an unbounded recipient array.
 *
 * `{ async: true }` on `@OnEvent` is a marker, not a fix: `setStatus` calls
 * `emit`, which invokes listeners in-process and never awaits them, so the
 * moderator's response was never blocked on this completing. The flag states
 * the fire-and-forget contract explicitly so a future `emitAsync` caller does
 * not accidentally start awaiting a fan-out. The work still shares this
 * process's event loop with request handling, which is exactly why the row
 * count above had to come down.
 *
 * The rest of the criteria (price bands, bedrooms, areas, availability) stays in
 * memory via `matchesHousingCriteria`: it is the same evaluator the browse SQL
 * mirrors, and duplicating all of it as jsonb predicates would give the two
 * copies room to disagree. `alertsEnabled` is the member's consent, so no extra
 * notification-preference category gates this type.
 */
@Injectable()
export class HousingSavedSearchAlertsListener {
  private readonly logger = new Logger(HousingSavedSearchAlertsListener.name);

  constructor(
    @InjectRepository(HousingSavedSearch)
    private readonly savedSearches: Repository<HousingSavedSearch>,
    private readonly notifications: NotificationsService,
  ) {}

  /** Rows per keyset page. Large enough that a realistic platform is one or two
   * queries, small enough that no single page is an unbounded materialisation. */
  private static readonly BATCH_SIZE = 500;

  @OnEvent(HOUSING_LISTING_WENT_LIVE, { async: true })
  async onListingWentLive(event: HousingListingWentLiveEvent): Promise<void> {
    try {
      const { listing, listingVerified } = event;

      // Order-preserving de-dup across ALL batches. The lister is seeded in so
      // they are never alerted about their own listing.
      // `ownerId` is NULL for a listing whose lister erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`): nobody to seed
      // out, so the set simply starts empty.
      const seen = new Set<string>(presentActorIds([listing.ownerId]));
      // Keyset cursor over the primary key: stable under concurrent inserts and
      // never re-reads a page, unlike OFFSET.
      let cursor: string | null = null;

      for (;;) {
        const page: HousingSavedSearch[] = await this.loadCandidatePage(
          listing,
          cursor,
        );
        if (!page.length) break;
        cursor = page[page.length - 1]!.id;

        const recipientIds: string[] = [];
        for (const search of page) {
          if (seen.has(search.memberId)) continue;
          if (
            matchesHousingCriteria(listing, search.criteria, listingVerified)
          ) {
            seen.add(search.memberId);
            recipientIds.push(search.memberId);
          }
        }

        // No actor — this is the platform telling you a home matched your
        // search, so no block/mute actorId. Payload carries what the bell/push
        // render + deep-link to the listing.
        //
        // Scoped catch: one page's write failing must not abandon the pages
        // behind it. The outer catch below wraps the SCAN, so before this an
        // error on page 2 also cost pages 3..N their alerts even though
        // nothing was wrong with them.
        if (recipientIds.length) {
          try {
            await this.notifications.createForRecipients(
              recipientIds,
              NotificationType.HousingListingMatch,
              {
                slug: listing.slug,
                title: listing.title,
                area: listing.area || listing.city,
              },
            );
          } catch (error) {
            this.report(
              `Housing saved-search alert page failed: listing=${listing.slug} recipients=${recipientIds.length}`,
              error,
            );
          }
        }

        if (page.length < HousingSavedSearchAlertsListener.BATCH_SIZE) break;
      }
    } catch (error) {
      // Alerting is best-effort, so a failure here is absorbed: it must never
      // affect the moderator's approve action that produced the event. It is
      // absorbed LOUDLY. `report` puts an error-level line with the stack and
      // a Sentry event on the record, so a failure that recurs on every new
      // listing is visible to someone who can go fix it.
      this.report(
        `Housing saved-search alert scan failed: listing=${event.listing.slug}`,
        error,
      );
    }
  }

  /**
   * How a swallowed alert failure becomes visible: an error-level log with a
   * stable, greppable prefix plus a Sentry capture, the same pair the app's
   * exception filters use for anything that would otherwise fail silently
   * (`AllExceptionsFilter`, `WsAllExceptionsFilter`). No new channel, and no
   * per-member detail on the wire beyond what the log line already carries.
   */
  private report(message: string, error: unknown): void {
    this.logger.error(
      `${message}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error, {
        tags: { area: 'housing-saved-search-alerts' },
      });
    }
  }

  /**
   * One keyset page of saved searches that COULD match this listing.
   *
   * The two predicates are written as "the knob is unset OR it equals this
   * listing's value", which is exactly how `matchesHousingCriteria` treats an
   * absent knob, so pushing them down cannot change the result — it only avoids
   * loading rows that were always going to be rejected in memory. `->>` yields
   * NULL for a missing key, so `IS NULL` covers both "key absent" and "key
   * explicitly null".
   */
  private loadCandidatePage(
    listing: HousingListingWentLiveEvent['listing'],
    cursor: string | null,
  ): Promise<HousingSavedSearch[]> {
    const qb = this.savedSearches
      .createQueryBuilder('s')
      .where('s.alerts_enabled = true')
      // `''` is checked alongside `IS NULL` because `matchesHousingCriteria`
      // treats an empty string as "unset" (a falsy guard), and the two
      // evaluators must not disagree. `btrim` mirrors its `equalsCaseInsensitive`
      // helper, which trims both sides before comparing.
      .andWhere(
        `(s.criteria->>'city' IS NULL
            OR s.criteria->>'city' = ''
            OR lower(btrim(s.criteria->>'city')) = lower(btrim(:city)))`,
        { city: listing.city },
      )
      .andWhere(
        `(s.criteria->>'type' IS NULL
            OR s.criteria->>'type' = ''
            OR s.criteria->>'type' = :type)`,
        { type: listing.type },
      )
      .orderBy('s.id', 'ASC')
      .limit(HousingSavedSearchAlertsListener.BATCH_SIZE);
    if (cursor) {
      // Explicit cast: the driver sends the cursor as an untyped text
      // parameter, and `uuid > text` has no operator.
      qb.andWhere('s.id > CAST(:cursor AS uuid)', { cursor });
    }
    return qb.getMany();
  }
}
