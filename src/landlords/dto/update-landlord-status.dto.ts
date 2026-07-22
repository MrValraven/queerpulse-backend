import { IsEnum } from 'class-validator';
import { LandlordStatus } from '../entities/landlord.entity';

export class UpdateLandlordStatusDto {
  @IsEnum(LandlordStatus)
  status: LandlordStatus;
}
