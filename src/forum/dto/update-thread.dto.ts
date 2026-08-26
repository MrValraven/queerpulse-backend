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
  // Optional since SOC-13: the tag editor patches `{ tags }` alone, and a
  // moderator filing someone else's thread must not have to resend (and so
  // re-stamp an edit revision on) a title they are not changing. Omitting it
  // leaves the title untouched; the service still refuses a title edit from
  // anyone but the author.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  // Replacement tag set (up to 5, each ≤ 24 chars). Normalized by the service
  // (trim, lowercase, strip `#`, dedupe, drop empties) before persisting.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  tags?: string[];
}
