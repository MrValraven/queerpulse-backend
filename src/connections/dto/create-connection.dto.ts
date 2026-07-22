import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateConnectionDto {
  @IsString()
  @MaxLength(200)
  toSlug: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  // Why the requester reached out: an "open to" preset (`open:<id>`), a member's
  // own words (`custom:<label>`), or a generic reason id. Free-form on purpose —
  // the frontend owns the vocabulary — so we only bound its length here.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  // Slug of a mutual connection who introduces the requester to a
  // `network`-visibility target. Required to reach such a target as a stranger.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  introducerSlug?: string;
}
