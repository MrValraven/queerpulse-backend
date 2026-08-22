import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { BarterCategory, BarterMode } from '../entities/barter-listing.entity';

/**
 * Body for `POST /barter`. Every string and array carries an explicit bound —
 * the global `ValidationPipe` runs with `whitelist`/`forbidNonWhitelisted`, so
 * unknown fields are rejected outright and these caps are what keeps a member
 * from posting an unbounded wall of text to a shared board.
 *
 * `offer`/`want` are both optional at the DTO level and cross-checked against
 * `mode` in the service (`BarterService.assertSidesMatchMode`): an `offering`
 * post needs an offer, a `seeking` post needs a want, and `both` needs each.
 * Keeping that rule in one place beats spreading it across conditional
 * validators, and it produces one clear message instead of two.
 */
export class CreateBarterListingDto {
  @IsEnum(BarterCategory)
  category!: BarterCategory;

  @IsEnum(BarterMode)
  mode!: BarterMode;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  offer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  want?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  offerDetail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  wantDetail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}
