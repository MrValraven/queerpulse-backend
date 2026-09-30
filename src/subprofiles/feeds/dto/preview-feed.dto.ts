import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Longest feed URL a member may paste. */
export const MAX_FEED_INPUT_URL_LENGTH = 2048;

// Body of `POST /subprofiles/feeds/preview`. The URL is only shape-checked
// here; `SubprofileFeedsService.normalizeFeedUrl` resolves a scheme-less or
// `feed:`/`itpc:` value to https and refuses anything else, and the fetch
// itself is SSRF-guarded.
export class PreviewFeedDTO {
  @ApiProperty({ description: 'The podcast RSS feed URL.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FEED_INPUT_URL_LENGTH)
  url!: string;

  @ApiPropertyOptional({
    description:
      'When given, `alreadyConnected` says whether this persona already has the feed. The caller must be a member of it.',
  })
  @IsOptional()
  @IsUUID('4')
  subprofileId?: string;
}
