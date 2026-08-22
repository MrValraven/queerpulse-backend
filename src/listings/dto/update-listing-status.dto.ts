import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListingStatus } from '../entities/listing.entity';

/** `PATCH /admin/listings/:ref/status` body — `setListingStatus(ref, status)` in
 * `listings.api.ts`. Moderator/admin-only (see `ListingsController`).
 * `reason` is optional free text (item #15): recorded on the moderation
 * event and, when the transition isn't an approval into `live`, included in
 * a best-effort DM to the submitter. */
export class UpdateListingStatusDto {
  @IsEnum(ListingStatus)
  status!: ListingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
