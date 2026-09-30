import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  FEED_ENTRY_STATUSES,
  type FeedEntryStatus,
} from '../../entities/subprofile-feed-entry.entity';

// Query of `GET /subprofiles/:id/feeds/:feedId/entries`. Omitting `status`
// lists every entry.
export class ListFeedEntriesQuery {
  @ApiPropertyOptional({ enum: FEED_ENTRY_STATUSES })
  @IsOptional()
  @IsIn(FEED_ENTRY_STATUSES)
  status?: FeedEntryStatus;
}
