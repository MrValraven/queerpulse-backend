import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

// `PATCH /forum/threads/:slug` body — `editThreadTitle(slug, title)` plus an
// optional `tags` replacement. Deliberately has no `category` field: a thread's
// category is fixed at create time, so the reserved-`"all"` guard lives on
// `CreateThreadDto` (the only path that sets a category) and there is nothing to
// re-validate here.
export class UpdateThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  // Replacement tag set (up to 5, each ≤ 24 chars). Normalized by the service
  // (trim, lowercase, strip `#`, dedupe, drop empties) before persisting.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  tags?: string[];
}
