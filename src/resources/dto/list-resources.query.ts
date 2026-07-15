import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListResourcesQuery {
  // Filters `Resource.category` (mirrors the FE's `library.data.ts`
  // `CATEGORIES` ids — kept as a free-form string, see the entity's comment).
  @IsOptional() @IsString() category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
