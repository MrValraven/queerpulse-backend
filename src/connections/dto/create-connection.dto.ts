import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateConnectionDto {
  @IsString()
  @MaxLength(200)
  toSlug: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  // Slug of a mutual connection who introduces the requester to a
  // `network`-visibility target. Required to reach such a target as a stranger.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  introducerSlug?: string;
}
