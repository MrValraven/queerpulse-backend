import { IsEnum } from 'class-validator';
import { HousingListingStatus } from '../entities/housing-listing.entity';

/** PATCH /admin/housing-listings/:ref/status body (moderator/admin only). */
export class UpdateHousingListingStatusDto {
  @IsEnum(HousingListingStatus)
  status: HousingListingStatus;
}
