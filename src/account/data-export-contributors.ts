import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConsentRecord } from '../consent/entities/consent-record.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Listing } from '../listings/entities/listing.entity';
import { MyCardsService } from '../membership-cards/my-cards.service';
import { Notification } from '../notifications/entities/notification.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { DataExportContribution } from './data-export-contributor';

/**
 * The export contributions for the domains the original monolithic export
 * builder silently missed (subprofiles, listings, housing, saved,
 * notifications, consent). Each is registered under `DATA_EXPORT_CONTRIBUTORS`
 * in `AccountModule` and only runs when its `category` is requested. All read
 * only the member's OWN rows and map to a stable, self-describing shape — no
 * raw entity is echoed to the wire.
 */

@Injectable()
export class SubprofilesExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'subprofiles';

  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.subprofiles.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((subprofile) => ({
      id: subprofile.id,
      kind: subprofile.kind,
      slug: subprofile.slug,
      handle: subprofile.handle,
      displayName: subprofile.displayName,
      tagline: subprofile.tagline,
      bio: subprofile.bio,
      status: subprofile.status,
      linkVisibility: subprofile.linkVisibility,
      createdAt: subprofile.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class ListingsExportContributor implements DataExportContribution {
  readonly category = 'listings';
  readonly archiveKey = 'listings';

  constructor(
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.listings.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((listing) => ({
      id: listing.id,
      ref: listing.ref,
      slug: listing.slug,
      name: listing.name,
      status: listing.status,
      createdAt: listing.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class HousingExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'housing';

  constructor(
    @InjectRepository(HousingListing)
    private readonly housingListings: Repository<HousingListing>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.housingListings.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((housingListing) => ({
      id: housingListing.id,
      slug: housingListing.slug,
      title: housingListing.title,
      city: housingListing.city,
      rentEuros: housingListing.rentEuros,
      status: housingListing.status,
      createdAt: housingListing.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class SavedExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'saved';

  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.savedItems.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((savedItem) => ({
      id: savedItem.id,
      subjectType: savedItem.subjectType,
      subjectId: savedItem.subjectId,
      title: savedItem.title,
      href: savedItem.href,
      savedAt: savedItem.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class NotificationsExportContributor implements DataExportContribution {
  readonly category = 'notifications';
  readonly archiveKey = 'notifications';

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.notifications.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((notification) => ({
      id: notification.id,
      type: notification.type,
      payload: notification.payload,
      read: notification.read,
      createdAt: notification.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class ConsentExportContributor implements DataExportContribution {
  readonly category = 'consent';
  readonly archiveKey = 'consent';

  constructor(
    @InjectRepository(ConsentRecord)
    private readonly consentRecords: Repository<ConsentRecord>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.consentRecords.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((consentRecord) => ({
      id: consentRecord.id,
      analytics: consentRecord.analytics,
      monitoring: consentRecord.monitoring,
      policyVersion: consentRecord.policyVersion,
      source: consentRecord.source,
      action: consentRecord.action,
      createdAt: consentRecord.createdAt.toISOString(),
    }));
  }
}

/**
 * Membership cards (spec §K.3) are personal data: a card ties a member to a
 * community and carries a serial that proves that membership at a door.
 * Delegates to `MyCardsService.forUser` rather than re-querying the tables
 * directly, so the archive's shape (status resolution against the
 * programme/community, holder name from `Profile`) always matches exactly
 * what the member sees on `GET /me/cards`.
 */
@Injectable()
export class MembershipCardsExportContributor implements DataExportContribution {
  readonly category = 'membershipCards';
  readonly archiveKey = 'membershipCards';

  constructor(private readonly myCards: MyCardsService) {}

  async buildContribution(userId: string): Promise<unknown> {
    return this.myCards.forUser(userId);
  }
}

/** Every newer-domain contributor, in archive order. */
export const NEW_DOMAIN_EXPORT_CONTRIBUTORS = [
  SubprofilesExportContributor,
  ListingsExportContributor,
  HousingExportContributor,
  SavedExportContributor,
  NotificationsExportContributor,
  ConsentExportContributor,
  MembershipCardsExportContributor,
] as const;
