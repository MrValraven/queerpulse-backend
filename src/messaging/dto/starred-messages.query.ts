import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * PRD-374: which slice of a starred hit's kind `type` narrows to, mirroring
 * the frontend toolbar's segmented control (`StarredMessageFilterType` in
 * `starredMessagesFilter.ts`) minus its client-only `"all"` value, which is
 * simply the absence of `type` here.
 */
export enum StarredMessagesFilterType {
  Photos = 'photos',
  Documents = 'documents',
  Links = 'links',
}

/**
 * Query for `GET /messages/starred`.
 *
 * `q` (PRD-374) is the free-text term matched server-side, accent- and
 * case-folded, against the message body, the attachment caption/file name,
 * the sender's display name, the group title, and the DM counterpart's
 * display name (see `MessageAnnotationsService.listStarredMessages`'s own
 * doc for the exact matching approach). A 100-char ceiling keeps the `LIKE`
 * pattern bounded; trimming happens in the service, mirroring
 * `SearchMessagesQuery`.
 *
 * `type` narrows by kind; omitted means every kind. `cursor` is the opaque
 * keyset cursor from the previous page's `nextCursor`, same codec as thread
 * history (`message-history-cursor.ts`): a value that fails to decode simply
 * falls back to the first page, still answering the request.
 */
export class StarredMessagesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(StarredMessagesFilterType)
  type?: StarredMessagesFilterType;

  @IsOptional()
  @IsString()
  cursor?: string;

  /**
   * Task 24: the mailbox to list stars from, by identity id. Present, only
   * stars on messages in threads where the caller's own seat speaks for that
   * identity are listed, and the caller must staff it
   * (`IDENTITY_NOT_STAFF` otherwise). Omitted, every starred message in the
   * merged inbox is listed, as before.
   */
  @IsOptional()
  @IsUUID()
  as?: string;
}
