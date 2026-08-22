import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TrimMessageBody } from './trim-message-body';

/**
 * A picked GIF's `url`/`previewUrl` are absolute provider URLs (`@IsUrl`); an
 * uploaded IMAGE's are a private storage key (`message-images/<uuid>/<uuid>.
 * <ext>`) — not a URL at all. `@IsUrl` would reject a bare key, so this
 * accepts either shape and `MessagingCoreService.postMessage` tells them apart
 * by `kind` (and, for `kind:'image'`, re-validates the key is a well-formed
 * `message-image` the CALLER actually owns — see `storageKeyOwnerId`).
 */
export class GifAttachmentDto {
  @IsString() @MinLength(1) @MaxLength(2048) url!: string;
  @IsString() @MinLength(1) @MaxLength(2048) previewUrl!: string;
  @IsInt() @Min(1) width!: number;
  @IsInt() @Min(1) height!: number;
  // Free-form (bounded) so swapping the GIF provider — or the attachment
  // source — never needs a DTO change.
  @IsString() @MaxLength(32) provider!: string;
}

export class SendMessageDto {
  @TrimMessageBody()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsUUID()
  replyToId?: string;

  /** Client-generated idempotency key (`crypto.randomUUID()`). Dedupes the dual
   *  HTTP + WS write paths and offline-outbox retries. */
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;

  /** True when this send is a FORWARD of another message's content. Persisted so
   *  the recipient's bubble can render a subtle "Forwarded" label. The message
   *  still goes through the ordinary idempotent send path.
   *
   *  DISPLAY HINT ONLY — never trusted for authorization. For a `kind:'image'`
   *  send, whether the attachment may skip the "must be your own upload"
   *  ownership check is DERIVED server-side from a message the sender provably
   *  had access to (see `MessagingCoreService.senderCanForwardAttachment`), not
   *  from this boolean; a client cannot bypass the check by setting it. */
  @IsOptional()
  @IsBoolean()
  forwarded?: boolean;

  /** `'gif'` marks this send as a provider GIF, `'image'` a member-uploaded
   *  photo (both require `attachment`); default/absent is an ordinary text
   *  bubble. */
  @IsOptional()
  @IsIn(['user', 'gif', 'image'])
  kind?: 'user' | 'gif' | 'image';

  /** The media attachment for a `kind:'gif'` or `kind:'image'` send. Ignored
   *  for text. */
  @IsOptional()
  @ValidateNested()
  @Type(() => GifAttachmentDto)
  attachment?: GifAttachmentDto;
}
