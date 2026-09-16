import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TrimMessageBody } from '../../messaging/dto/trim-message-body';

export class CreateConnectionDto {
  @IsString()
  @MaxLength(200)
  toSlug!: string;

  @TrimMessageBody()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  // Why the requester reached out: an "open to" preset (`open:<id>`), a member's
  // own words (`custom:<label>`), or a generic reason id. Free-form on purpose,
  // the frontend owns the vocabulary, so we only bound its length here. The
  // `custom:<label>` form carries member-typed prose shown to the addressee, the
  // same class of text as `message`, so it gets the same control-byte strip.
  @TrimMessageBody()
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
