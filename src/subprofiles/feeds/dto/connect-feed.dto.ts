import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MAX_FEED_INPUT_URL_LENGTH } from './preview-feed.dto';

export const FEED_BACKFILL_MODES = ['all', 'none'] as const;
export type FeedBackfillMode = (typeof FEED_BACKFILL_MODES)[number];

// Body of `POST /subprofiles/:id/feeds`. `section` is only shape-checked
// here: whether it is one the persona's kind has (and not `links`/`gallery`)
// needs the persona row, so the service answers that with a 400.
export class ConnectFeedDTO {
  @ApiProperty({ description: 'The podcast RSS feed URL.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FEED_INPUT_URL_LENGTH)
  url!: string;

  @ApiProperty({ description: 'The section episodes publish into.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  section!: string;

  @ApiPropertyOptional({
    description: 'Publish new episodes straight away instead of queueing them.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  autoPublish?: boolean;

  @ApiProperty({
    enum: FEED_BACKFILL_MODES,
    description:
      '`all`: every current episode becomes a pending entry. `none`: current episodes are recorded as dismissed; only future ones arrive as pending.',
  })
  @IsIn(FEED_BACKFILL_MODES)
  backfill!: FeedBackfillMode;
}
