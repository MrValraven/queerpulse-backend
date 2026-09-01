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
 * Body for `PATCH /barter/:id`, the poster's correction path (PRD-42). Before
 * it, a swap could never be edited: a typo in the headline was permanent and
 * the only escape was closing the post and writing it again, which dropped
 * every proposal already made against it.
 *
 * Written out field by field rather than as `PartialType(CreateBarterListingDto)`
 * so the editable set is stated here in one place. The global `ValidationPipe`
 * runs `whitelist` + `forbidNonWhitelisted`, so anything not named below is
 * rejected outright: `status` is not editable here (that is `POST :id/close`),
 * and neither is `ownerId`, which has no wire representation at all.
 *
 * Every field is optional and absent means "leave it alone". `offer`/`want` are
 * cross-checked against the MERGED `mode` in `BarterService.update`, exactly as
 * `create` does through `assertSidesMatchMode`, so a post can never be patched
 * into advertising a side it no longer carries.
 */
export class UpdateBarterListingDto {
  @IsOptional()
  @IsEnum(BarterCategory)
  category?: BarterCategory;

  @IsOptional()
  @IsEnum(BarterMode)
  mode?: BarterMode;

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
