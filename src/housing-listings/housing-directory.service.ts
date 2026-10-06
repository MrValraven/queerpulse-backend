import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { escapeLikeTerm } from '../common/like-escape';
import {
  foldedHaystack,
  foldedSearchTerm,
  HOUSING_LISTING_SEARCH_COLUMNS,
} from '../search/search-text';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { BlockFilterService } from '../social/block-filter.service';
import { BrowseHousingListingsQuery } from './dto/browse-housing-listings.query';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import {
  HOUSING_FURNISHED_FEATURE,
  HOUSING_PETS_WELCOME_FEATURE,
  normalizeHousingFeature,
} from './housing-features';
import { HousingListerLookup } from './housing-lister-lookup';
import { VERIFIED_LISTING_MAX_RISK } from './housing-verified';
import {
  HousingListingDTO,
  HousingLocationUnlock,
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
    // ENG-470: a block either way (and the viewer's own mute) takes the other
    // member's homes off browse and search, and a block 404s the detail,
    // the same severance the flatmate board applies.
    private readonly blockFilter: BlockFilterService,
  ) {}

  // A housing listing is reported (and taken down) under the `housing` subject
  // code, keyed by the listing slug. A hidden OR removed listing vanishes from
  // public browse/detail/search for everyone — a public surface with no
  // per-viewer staff role, so (like the directory) a takedown withholds it
  // entirely. The owner still manages it through the owner-gated
  // `HousingListingsService` routes, which don't re-check this state.
  private static readonly SUBJECT_TYPE = 'housing';

  /**
   * "This listing's `features` array carries the chip bound to `parameter`",
   * as SQL. `features` is a `text[]`, so this unnests it and compares each
   * entry whole, case-insensitively: the exact contract
   * `hasHousingFeature`/`normalizeHousingFeature` implement in memory for the
   * saved-search alert fan-out. The two must keep agreeing, or an alert fires
   * for a listing the board would not show.
   *
   * `= ANY(:array)` (the shape the `areas` multi-select uses) is deliberately
   * NOT the operator here: that tests one scalar column against a list of
   * candidate values, where this tests one candidate value against a list held
   * in the column.
   */
  private featurePredicate(parameter: string): string {
    return `EXISTS (
      SELECT 1 FROM unnest(l.features) AS listing_feature
      WHERE lower(btrim(listing_feature)) = :${parameter}
    )`;
  }

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

  /**
   * @param viewerId The member browsing. When present, homes listed by anyone
   *   blocked either way with them, or muted by them, are dropped in-query
   *   (ENG-470), so the page and its total stay consistent.
   */
  async browse(
    query: BrowseHousingListingsQuery,
    viewerId?: string,
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
    if (query.furnished) {
      qb.andWhere(this.featurePredicate('furnishedFeature'), {
        furnishedFeature: normalizeHousingFeature(HOUSING_FURNISHED_FEATURE),
      });
    }
    if (query.petsWelcome) {
      qb.andWhere(this.featurePredicate('petsWelcomeFeature'), {
        petsWelcomeFeature: normalizeHousingFeature(
          HOUSING_PETS_WELCOME_FEATURE,
        ),
      });
    }
    if (query.depositMax !== undefined) {
      // A listing with no stated deposit can't satisfy a deposit cap. Spelled
      // out rather than left to SQL's NULL <= n, so the intent reads: an
      // unstated deposit is UNKNOWN, never zero.
      qb.andWhere(
        '(l.deposit_euros IS NOT NULL AND l.deposit_euros <= :depositMax)',
        { depositMax: query.depositMax },
      );
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
    if (viewerId !== undefined) {
      // Raw column reference in the DB's snake_case (SnakeNamingStrategy).
      this.blockFilter.excludeHidden(qb, viewerId, '"l"."owner_id"');
    }
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
  // `browse`'s visibility), accent-folded match over title / blurb / city /
  // area, so "Principe Real" finds a listing in "Príncipe Real". No lister
  // hydration: the search row needs none. With a `viewerId`, homes listed by
  // a member blocked either way or muted by the viewer drop out (ENG-470),
  // as on `browse`.
  async searchByText(
    term: string,
    limit: number,
    viewerId?: string,
  ): Promise<HousingSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const qbSearch = this.listings
      .createQueryBuilder('l')
      .where('l.status = :live', { live: HousingListingStatus.Live })
      // Same filled/expired withhold as `browse` above.
      .andWhere('l.filled_at IS NULL')
      .andWhere('l.expires_at > :now', { now: new Date() })
      .andWhere(
        `${foldedHaystack('l', HOUSING_LISTING_SEARCH_COLUMNS)} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        { pattern },
      );
    this.excludeModeratedListings(qbSearch);
    if (viewerId !== undefined) {
      this.blockFilter.excludeHidden(qbSearch, viewerId, '"l"."owner_id"');
    }
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
    // ENG-470: a block either way hides the home entirely, as the same 404 so
    // the response never confirms the listing exists (the flatmate board's
    // `detail` does the same).
    if (
      !isOwner &&
      listerId !== null &&
      (await this.blockFilter.isBlockedEitherWay(viewerId, listerId))
    ) {
      throw new NotFoundException('Housing listing not found');
    }
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
    //
    // DES-419: the gates are checked in this order and the first that passes
    // is reported as `locationUnlockedVia`, so the client can say WHY the
    // address is showing. ENG-467: a viewing unlock also needs the pair to be
    // unblocked, and a viewing completed before the home was relisted no
    // longer counts.
    const unlockedVia = await this.resolveLocationUnlock(listing, viewerId);
    const precise = unlockedVia !== null;

    return toHousingListingDTO(
      listing,
      actorFromLookup(refs, listerId) ?? null,
      level,
      precise,
      false,
      unlockedVia ?? undefined,
    );
  }

  /** Which address-privacy gate `viewerId` passes on `listing`, owner first,
   * then connection, then viewing; null when none does. */
  private async resolveLocationUnlock(
    listing: HousingListing,
    viewerId: string,
  ): Promise<HousingLocationUnlock | null> {
    const listerId = listing.ownerId;
    if (listerId !== null && listerId === viewerId) return 'owner';
    if (
      listerId !== null &&
      (await this.connections.areConnected(viewerId, listerId))
    ) {
      return 'connection';
    }
    const hasViewingUnlock = await this.viewings.hasUnlockedViewing(
      listing.id,
      viewerId,
      { listerId, relistedAt: listing.relistedAt },
    );
    return hasViewingUnlock ? 'viewing' : null;
  }
}
