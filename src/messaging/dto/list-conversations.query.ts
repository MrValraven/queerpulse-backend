import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ConversationKind } from '../entities/conversation.entity';

/** ENG-403: the only `kind` narrowing the list accepts. The forward
 *  picker asks for groups; a direct-thread filter has no caller yet. */
export const LIST_CONVERSATIONS_KINDS = [ConversationKind.Group] as const;

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

  /**
   * ENG-403: narrows the page to conversations whose name, as the list row
   * shows it, contains this text: a group's title, or the partner's name on
   * a direct thread. Matched case- and accent-insensitively
   * (`foldedTextExpression`), the way every other backend search folds.
   * Blank after trimming, it narrows nothing. Every visibility rule of the
   * list still applies, so a search page is always a subset of the plain
   * one, and `cursor`/`limit` page it the same way.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** ENG-403: `group` keeps only group conversations, including groups the
   *  caller left (the plain list's own rule). Omitted, every kind. */
  @IsOptional()
  @IsIn(LIST_CONVERSATIONS_KINDS)
  kind?: (typeof LIST_CONVERSATIONS_KINDS)[number];

  /**
   * ENG-403: `true` keeps only the conversations the caller still holds a
   * seat in (`left_at IS NULL`), dropping every group they left or were
   * removed from. The forward picker sends it, so its bounded page holds
   * groups a message can actually go to. Only the literal `"true"` turns it
   * on; anything else reads as `false`, the plain list. Mirrors
   * `RemoveMemberQuery`'s boolean.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  excludeLeft?: boolean;
}
