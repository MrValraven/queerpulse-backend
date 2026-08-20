import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import {
  ResourceListing,
  ResourceListingCategory,
  ResourceListingStatus,
} from './entities/resource-listing.entity';
import {
  ResourceListingResponseDTO,
  toResourceListingResponse,
} from './resource-listing-response';

/**
 * Public directory read model: active listings only, optionally filtered by
 * category — the real backing for the Legal Aid / Sexual Health Testing
 * resource pages (CNT-14). Small curated set, so this is a plain capped
 * array like `OrgTiersService.listPublished`, not a `Paginated<T>` envelope.
 */
@Injectable()
export class ResourceListingsService {
  constructor(
    @InjectRepository(ResourceListing)
    private readonly listings: Repository<ResourceListing>,
  ) {}

  async list(
    category?: ResourceListingCategory,
  ): Promise<ResourceListingResponseDTO[]> {
    const rows = await this.listings.find({
      where: category
        ? { status: ResourceListingStatus.Active, category }
        : { status: ResourceListingStatus.Active },
      order: { title: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toResourceListingResponse);
  }
}
