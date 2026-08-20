import { IsEnum, IsOptional } from 'class-validator';
import { ResourceListingCategory } from '../entities/resource-listing.entity';

/** Shared by the public `GET /resources/listings` and the admin
 *  `GET /admin/resource-listings` list endpoints. */
export class ListResourceListingsQuery {
  @IsOptional()
  @IsEnum(ResourceListingCategory)
  category?: ResourceListingCategory;
}
