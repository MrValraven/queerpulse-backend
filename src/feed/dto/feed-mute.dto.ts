import { IsEnum, IsUUID } from 'class-validator';
import { FeedSourceKind } from '../entities/feed-source-mute.entity';

/** `POST /feed/mutes` body — the source to turn down in the caller's feed. */
export class CreateFeedMuteDto {
  @IsEnum(FeedSourceKind)
  sourceKind!: FeedSourceKind;

  @IsUUID()
  sourceId!: string;
}
