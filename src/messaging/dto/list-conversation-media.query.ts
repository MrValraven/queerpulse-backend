import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MAX_CONVERSATION_MEDIA_LIMIT } from '../messaging.constants';

/**
 * Which gallery tab `GET /conversations/:id/media` lists (PRD-373):
 *  - `media`: image and GIF messages.
 *  - `links`: ordinary text messages whose body carries an `http://` or
 *    `https://` address or a bare `www.` host. Captions on image and document
 *    messages do not count.
 *  - `documents`: document attachments (a lease PDF, a flyer, a spreadsheet).
 */
export enum ConversationMediaKind {
  Media = 'media',
  Links = 'links',
  Documents = 'documents',
}

/** Query for `GET /conversations/:id/media`. */
export class ListConversationMediaQuery {
  @IsEnum(ConversationMediaKind)
  kind!: ConversationMediaKind;

  // Opaque cursor taken from the previous page's `pageInfo.nextCursor`. Same
  // codec as thread history (`src/messaging/message-history-cursor.ts`), so it
  // keeps the boundary row's exact microsecond created_at. A value that does
  // not decode falls back to the first page.
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CONVERSATION_MEDIA_LIMIT)
  limit?: number;
}
