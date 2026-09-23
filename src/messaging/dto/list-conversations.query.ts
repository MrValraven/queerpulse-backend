import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Query for `GET /conversations` (ENG-253). `cursor` is the opaque keyset
 * cursor from the previous page's `pageInfo.nextCursor`; omitted for the
 * first page, and a value that fails to decode simply falls back to the
 * first page rather than failing the request (see `decodeCursor`).
 *
 * `limit` bounds the page size, mirroring `GetMessagesQuery`'s own
 * `DEFAULT_LIMIT`/`MAX_LIMIT` (30/100, see `messaging.constants.ts`) rather
 * than inventing a third ceiling for one more messaging list endpoint.
 */
export class ListConversationsQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Task 24: the mailbox to list, by identity id. Present, the page holds
   * only the threads where the caller's own seat speaks for that identity,
   * and the caller must staff it (`IDENTITY_NOT_STAFF` otherwise). Omitted,
   * the page is the merged inbox across every mailbox, as before.
   */
  @IsOptional()
  @IsUUID()
  as?: string;
}
