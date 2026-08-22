import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { BarterCategory, BarterMode } from '../entities/barter-listing.entity';

/**
 * Query for `GET /barter`, matching the board's own controls exactly: the
 * category chips, the offering/seeking tabs, and the search box. Omitting a
 * facet is the "All" chip — there is no sentinel `'all'` value to validate,
 * which is why `category`/`mode` are plain optional enums.
 *
 * `q` is capped and escaped for `ILIKE` at the query site
 * (`escapeLikeTerm`), so a member pasting `%` searches for a literal percent
 * sign instead of matching the whole board.
 */
export class ListBarterQuery {
  @IsOptional()
  @IsEnum(BarterCategory)
  category?: BarterCategory;

  @IsOptional()
  @IsEnum(BarterMode)
  mode?: BarterMode;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
