import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  toHousingListingDTO,
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
  ) {}

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

  async detail(slug: string): Promise<HousingListingDTO> {
    const listing = await this.listings.findOne({
      where: { slug, status: HousingListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    const refs = await new MemberLookup(this.profiles).byUserIds([
      listing.ownerId,
    ]);
    return toHousingListingDTO(listing, refs.get(listing.ownerId) ?? null);
  }
}
