import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * `PATCH /magazine/admin/issues/:number/cover` body (Magazine Desk Phase 5):
 * both fields are independently optional so the cover-art field and the
 * coverlines list can be saved separately.
 */
export class UpdateCoverDto {
  // An uploaded storage key or an `https://` URL, like every other image field
  // — was a bare `@IsString()`, so a `javascript:`/`data:` URI could be
  // persisted and then rendered on the issue page. `''` clears the cover.
  @IsOptional()
  @IsImageReference()
  coverUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  coverlines?: string[];
}
