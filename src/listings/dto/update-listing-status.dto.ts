import { IsEnum } from 'class-validator';
import { ListingStatus } from '../entities/listing.entity';

/** `PATCH /listings/:ref/status` body — `setListingStatus(ref, status)` in
 * `listings.api.ts`. Moderator/admin-only (see `ListingsController`). */
export class UpdateListingStatusDto {
  @IsEnum(ListingStatus)
  status: ListingStatus;
}
