import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { CommissionCategory } from '../entities/commission-interest.entity';

/** Query for the admin commission-interest oversight list: paginated,
 * newest-first, optionally narrowed to a single commission category. */
export class ListAdminCommissionInterestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(CommissionCategory)
  category?: CommissionCategory;
}
