import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { escapeLikeTerm } from '../common/like-escape';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { BrowseHousingListingsQuery } from './dto/browse-housing-listings.query';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import { HousingListerLookup } from './housing-lister-lookup';
import { VERIFIED_LISTING_MAX_RISK } from './housing-verified';
import {
  HousingListingDTO,
  HousingSearchRow,
  toHousingListingDTO,
  toHousingSearchRow,
} from './housing-listing-response';

/**
 * Public browse over LIVE housing listings only. Every filter is optional;
 * with none set this returns every live listing, newest first. The frontend
 * also filters client-side, so server filters are a narrowing optimisation.
 */
@Injectable()
export class HousingDirectoryService {
  constructor(
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // Read-only: a `hide_content`/`remove_content` takedown on a `housing`
    // subject (keyed by the listing slug — what the frontend report modal
    // sends) withholds the listing from every public read below.
    private readonly contentModeration: ContentModerationService,
    private readonly verification: VerificationService,
    // ADDRESS PRIVACY: the exact point + address are disclosed on the detail
    // read only to the owner or a mutually-connected member. `areConnected` is
    // the platform's canonical "these two trust each other" signal. (See
    // `detail` for why this stands in for "accepted enquirer" today.)
    private readonly connections: ConnectionsService,
    // Accepted-viewing address unlock (P2.3): an enquirer whose viewing request
    // the lister ACCEPTED is treated as trusted enough to see the exact address,
    // fulfilling the map slice's documented follow-up.
    private readonly viewings: HousingViewingsService,
  ) {}

  // A housing listing is reported (and taken down) under the `housing` subject
  // code, keyed by the listing slug. A hidden OR removed listing vanishes from
  // public browse/detail/search for everyone — a public surface with no
  // per-viewer staff role, so (like the directory) a takedown withholds it
  // entirely. The owner still manages it through the owner-gated
  // `HousingListingsService` routes, which don't re-check this state.
  private static readonly SUBJECT_TYPE = 'housing';

  // NOT EXISTS predicate dropping any listing under a `housing` takedown
  // (hidden OR removed) from a listing query builder (alias `l`), in-query so
  // the paginated/capped result stays consistent. Mirrors
  // `DirectoryService.excludeModeratedListings`.
  private excludeModeratedListings(
    qb: SelectQueryBuilder<HousingListing>,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :housingSubjectType
          AND "cm"."subject_id" = l.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { housingSubjectType: HousingDirectoryService.SUBJECT_TYPE },
    );
  }

  async browse(
    query: BrowseHousingListingsQuery,
  ): Promise<Paginated<HousingListingDTO>> {
    const page = normalizePage(query.page);
    const qb = this.listings
      .createQueryBuilder('l')
      .where('l.status = :live', { live: HousingListingStatus.Live })
      // HSG-1 / HSG-3: a member-filled ("found a place") or expired listing is
      // withheld from public browse — checked here (not just left to the daily
      // sweep) so there is never a same-day lag where a stale listing still
      // shows. Backed by IDX_housing_listings_status_expires_at.
      .andWhere('l.filled_at IS NULL')
      .andWhere('l.expires_at > :now', { now: new Date() });

    if (query.type) {
      qb.andWhere('l.type = :type', { type: query.type });
    }
    if (query.city) {
      // LOWER(city) matches the functional index added in the filter migration.
      qb.andWhere('LOWER(l.city) = LOWER(:city)', { city: query.city });
    }
    if (query.area) {
      // Same case-insensitive equality as city, backed by LOWER(area) index.
      qb.andWhere('LOWER(l.area) = LOWER(:area)', { area: query.area });
    }
    if (query.areas?.length) {
      // Neighbourhood multi-select: OR across the chosen areas, still backed by
      // the LOWER(area) functional index. Independent of the legacy single
      // `area` above (the UI sends only `areas`).
      qb.andWhere('LOWER(l.area) = ANY(:areas)', {
        areas: query.areas.map((area) => area.toLowerCase()),
      });
    }
    if (query.priceMin !== undefined) {
      qb.andWhere('l.rent_euros >= :priceMin', { priceMin: query.priceMin });
    }
    if (query.priceMax !== undefined) {
      qb.andWhere('l.rent_euros <= :priceMax', { priceMax: query.priceMax });
    }
    if (query.bedroomsMin !== undefined) {
      // A listing with no bedroom count set can't satisfy a minimum-beds filter.
      qb.andWhere('l.bedrooms >= :bedroomsMin', {
        bedroomsMin: query.bedroomsMin,
      });
    }
    if (query.billsIncluded) {
      qb.andWhere('l.bills_included = true');
    }
    if (query.hasAccessibilityInfo) {
      qb.andWhere("l.accessibility_info <> ''");
    }
    if (query.verifiedOnly) {
      // The public "verified listing" derivation, expressed in-query: status is
      // already `live` above, so verified reduces to a low pre-publish risk
      // score AND an id-verified lister. Kept in lockstep with
      // `deriveListingVerified` (housing-verified.ts).
      qb.andWhere('l.risk_score < :maxRisk', {
        maxRisk: VERIFIED_LISTING_MAX_RISK,
      }).andWhere(
        `EXISTS (
          SELECT 1 FROM "member_verifications" "mv"
          WHERE "mv"."user_id" = l.owner_id
            AND "mv"."level" = :idVerifiedLevel
        )`,
        { idVerifiedLevel: VerificationLevel.IdVerified },
      );
    }
    if (query.availableBy) {
      // A listing with no move-in date is treated as available anytime.
      qb.andWhere(
        '(l.available_from IS NULL OR l.available_from <= :availableBy)',
        { availableBy: query.availableBy },
      );
    }

    this.excludeModeratedListings(qb);
    qb.orderBy('l.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      // NULL for a listing whose lister erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`). The row keeps
      // its reviews and viewings; it just has no lister to name, and
      // `ContentOwnerErasureService` has already marked it filled so it is
      // off the market.
      const ownerIds = presentActorIds(rows.map((r) => r.ownerId));
      // `HousingListerLookup` is the same single `profiles.find` MemberLookup
      // issues, mapped to the richer lister block (member-since + bio) the
      // housing card and detail actually render.
      const refs = await new HousingListerLookup(this.profiles).byUserIds(
        ownerIds,
      );
      const levels = await this.verification.levelsForUsers(ownerIds);
      return rows.map((r) =>
        toHousingListingDTO(
          r,
          actorFromLookup(refs, r.ownerId) ?? null,
          actorFromLookup(levels, r.ownerId) ?? VerificationLevel.Email,
        ),
      );
    });
  }

  // Cross-entity global search (SearchService) — LIVE listings only (mirrors
  // `browse`'s visibility), ILIKE over title / blurb / city / area. No lister
  // hydration — the search row needs none.
  async searchByText(term: string, limit: number): Promise<HousingSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const qbSearch = this.listings
      .createQueryBuilder('l')
      .where('l.status = :live', { live: HousingListingStatus.Live })
      // Same filled/expired withhold as `browse` above.
      .andWhere('l.filled_at IS NULL')
      .andWhere('l.expires_at > :now', { now: new Date() })
      .andWhere(
        '(l.title ILIKE :pattern OR l.blurb ILIKE :pattern OR l.city ILIKE :pattern OR l.area ILIKE :pattern)',
        { pattern },
      );
    this.excludeModeratedListings(qbSearch);
    const rows = await qbSearch
      .orderBy('l.created_at', 'DESC')
      .take(limit)
      .getMany();
    return rows.map(toHousingSearchRow);
  }

  /**
   * Public detail read. `viewerId` gates ADDRESS PRIVACY: the exact point +
   * full address are attached only when the viewer owns the listing or is a
   * mutually-connected member — everyone else gets the approximate
   * neighbourhood pin. See `precise` note below on the connection signal.
   */
  async detail(slug: string, viewerId: string): Promise<HousingListingDTO> {
    const listing = await this.listings.findOne({
      where: { slug, status: HousingListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    // A moderator takedown (hidden OR removed) withholds the public detail as a
    // 404 — the same withhold-entirely behaviour as browse/search above.
    const moderation = await this.contentModeration.stateFor(
      HousingDirectoryService.SUBJECT_TYPE,
      slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Housing listing not found');
    }
    // HSG-1 / HSG-3: a filled or expired listing 404s for everyone EXCEPT its
    // own owner — the owner still reaches this same public detail route
    // (`GET /housing-directory/:slug`, the one `HousingListingPage` renders)
    // from their "My Listings" management view to see/un-mark it, while a
    // stranger following an old link or search hit gets the same honest 404 a
    // moderation takedown would give.
    const isOwner = listing.ownerId !== null && listing.ownerId === viewerId;
    const isWithheld =
      listing.filledAt !== null || listing.expiresAt.getTime() < Date.now();
    if (!isOwner && isWithheld) {
      throw new NotFoundException('Housing listing not found');
    }
    const listerId = listing.ownerId;
    const refs = await new HousingListerLookup(this.profiles).byUserIds(
      presentActorIds([listerId]),
    );
    // An erased lister has no verification standing left to show: fall back to
    // the lowest level rather than inventing one.
    const level =
      listerId === null
        ? VerificationLevel.Email
        : await this.verification.levelForUser(listerId);

    // Precise-vs-area gate. The exact point + address are disclosed to (a) the
    // owner, (b) a mutually-connected member (the platform's canonical
    // trust signal), OR (c) an enquirer whose VIEWING request the lister
    // ACCEPTED — the explicit "lister let this enquirer in" state that the map
    // slice flagged as the production refinement, now realised via
    // housing_viewings. A cold enquiry still deliberately creates no connection,
    // so an unanswered enquiry never unlocks the address.
    // With an erased lister there is nobody to be connected to, so the
    // precise-location unlock falls back to the accepted-viewing signal alone.
    const precise =
      (listerId !== null &&
        (listerId === viewerId ||
          (await this.connections.areConnected(viewerId, listerId)))) ||
      (await this.viewings.hasUnlockedViewing(listing.id, viewerId));

    return toHousingListingDTO(
      listing,
      actorFromLookup(refs, listerId) ?? null,
      level,
      precise,
    );
  }
}
