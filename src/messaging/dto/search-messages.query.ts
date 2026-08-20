import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Query for `GET /messages/search`. `q` is the free-text term matched against
 * message bodies (case-insensitive substring, server-side). Bounded at both ends
 * — a 1-char floor keeps the result set meaningful, a 200-char ceiling caps the
 * `ILIKE` pattern length — and `limit` clamps the page the service returns.
 *
 * `conversationId`, when supplied, narrows the search to a single thread (the
 * "search in this chat" mode opened from an already-open conversation) instead
 * of the caller's whole inbox. It is additive on top of — never a replacement
 * for — the participation join in `MessagingService.searchMessages`: a
 * conversation id the caller doesn't belong to simply yields zero rows, so
 * this can't be used to probe a thread the caller isn't in.
 */
export class SearchMessagesQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
