import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

export class ListResourcesQuery {
  // Filters `Resource.category` (mirrors the FE's `library.data.ts`
  // `CATEGORIES` ids — kept as a free-form string, see the entity's comment).
  @IsOptional() @IsString() category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
