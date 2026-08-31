import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Every frame label the reframe editor can emit, and the only values allowed
 * into the `media_crops.crop` jsonb.
 *
 * The jsonb blob is echoed back verbatim into listing, community, persona and
 * magazine responses, so this is the one place its string field is closed.
 * Derived from the frontend's `CROP_CONFIG` (`src/features/members/api/
 * uploadProcessing.ts`) plus the two labels `useImageReframerState` synthesises
 * for the freeform ratio chips:
 *   - '1:1'      avatar, group-avatar, and the "Square" freeform chip
 *   - '2:1'      story-cover, community-cover, listing-photo
 *   - '3:1'      persona-cover
 *   - 'original' the "Original" freeform chip (the source's own ratio)
 *   - 'free'     the identity crop's label
 * Adding a locked aspect to `CROP_CONFIG` means adding its label here too.
 */
export const CROP_ASPECTS = ['1:1', '2:1', '3:1', 'original', 'free'] as const;

export class CropRectDto {
  @IsNumber() @Min(0) @Max(1) x!: number;
  @IsNumber() @Min(0) @Max(1) y!: number;
  @IsNumber() @Min(0) @Max(1) width!: number;
  @IsNumber() @Min(0) @Max(1) height!: number;
  @IsString() @IsIn(CROP_ASPECTS) aspect!: string;
}

export class SaveCropDto {
  @IsString() key!: string;

  @ValidateNested()
  @Type(() => CropRectDto)
  crop!: CropRectDto;
}
