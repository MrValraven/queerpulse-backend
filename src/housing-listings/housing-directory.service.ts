import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { BrowseHousingListingsQuery } from './dto/browse-housing-listings.query';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
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
      .where('l.status = :live', { live: HousingListingStatus.Live });

    if (query.type) {
      qb.andWhere('l.type = :type', { type: query.type });
    }
    if (query.city) {
      qb.andWhere('LOWER(l.city) = LOWER(:city)', { city: query.city });
    }
    if (query.priceMin !== undefined) {
      qb.andWhere('l.rent_euros >= :priceMin', { priceMin: query.priceMin });
    }
    if (query.priceMax !== undefined) {
      qb.andWhere('l.rent_euros <= :priceMax', { priceMax: query.priceMax });
    }
    if (query.lgbtqFriendly) {
      qb.andWhere('l.lgbtq_friendly = true');
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
      const refs = await new MemberLookup(this.profiles).byUserIds(
        rows.map((r) => r.ownerId),
      );
      return rows.map((r) =>
        toHousingListingDTO(r, refs.get(r.ownerId) ?? null),
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

  async detail(slug: string): Promise<HousingListingDTO> {
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
    const refs = await new MemberLookup(this.profiles).byUserIds([
      listing.ownerId,
    ]);
    return toHousingListingDTO(listing, refs.get(listing.ownerId) ?? null);
  }
}
