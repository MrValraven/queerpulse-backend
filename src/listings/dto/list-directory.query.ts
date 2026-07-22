import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Optional server-side filters for the public directory grid. The frontend
 * also filters client-side (it renders a "showing X of Y" count over the full
 * set), so both are honored: omitting these returns every live listing.
 */
export class ListDirectoryQuery {
  /** Category slug — matches when present in the listing's `cats`. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cat?: string;

  /** Free-text search over name / blurb / hood. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
