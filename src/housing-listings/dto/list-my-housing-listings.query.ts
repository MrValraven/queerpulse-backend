import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** GET /housing-listings/mine query. */
export class ListMyHousingListingsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
