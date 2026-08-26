import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { LandlordStatus } from '../entities/landlord.entity';

/**
 * `PATCH /admin/landlords/:id/status` body.
 *
 * `reason` is the LOC-19 addition: the member who suggested the entry is now
 * told the outcome. The service REQUIRES it when a suggested entry is held
 * back to `review`, and leaves it optional on `live`, where the notification
 * is good news and needs no justification.
 */
export class UpdateLandlordStatusDto {
  @IsEnum(LandlordStatus)
  status!: LandlordStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
