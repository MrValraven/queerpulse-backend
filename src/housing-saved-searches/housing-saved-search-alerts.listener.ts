import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
 * Efficiency: ONE query loads every alerts-enabled saved search, matching runs
 * in memory (the criteria is jsonb — cheap to evaluate, awkward to express as a
 * per-listing SQL predicate), recipients are de-duplicated, and a SINGLE
 * `createForRecipients` write covers the whole fan-out — no per-search or
 * per-recipient query. `alertsEnabled` is the member's consent, so no extra
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

  @OnEvent(HOUSING_LISTING_WENT_LIVE)
  async onListingWentLive(event: HousingListingWentLiveEvent): Promise<void> {
    try {
      const { listing, listingVerified } = event;
      const searches = await this.savedSearches.find({
        where: { alertsEnabled: true },
      });
      if (!searches.length) return;

      // Unique members whose search matches — excluding the lister (never alert
      // someone about their own listing). Order-preserving de-dup.
      const recipientIds: string[] = [];
      const seen = new Set<string>([listing.ownerId]);
      for (const search of searches) {
        if (seen.has(search.memberId)) continue;
        if (matchesHousingCriteria(listing, search.criteria, listingVerified)) {
          seen.add(search.memberId);
          recipientIds.push(search.memberId);
        }
      }
      if (!recipientIds.length) return;

      // No actor — this is the platform telling you a home matched your search,
      // so no block/mute actorId. Payload carries what the bell/push render +
      // deep-link to the listing.
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
      // Alerting is best-effort — a failure here must never affect the
      // moderator's approve action that produced the event.
      this.logger.warn(`Housing saved-search alert failed: ${String(error)}`);
    }
  }
}
