import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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
 * uploaded IMAGE's or DOCUMENT's are a private storage key
 * (`message-images/<uuid>/<uuid>.<ext>` / `message-documents/<uuid>/<uuid>.
 * <ext>`) — not a URL at all. `@IsUrl` would reject a bare key, so this
 * accepts either shape and `MessagingCoreService.postMessage` tells them apart
 * by `kind` (and, for `kind:'image'`/`kind:'document'`, re-validates the key
 * is a well-formed `message-image`/`message-document` the CALLER actually
 * owns — see `storageKeyOwnerId`).
 *
 * Carries BOTH the gif/image fields (`previewUrl`/`width`/`height`) and the
 * document fields (`fileName`/`byteSize`/`contentType`), all optional except
 * `url`/`provider` — one class covering three send kinds, kept under its
 * original name for the SAME reason `GifAttachment` on the `Message` entity
 * stayed named after its history (see that interface's own doc): renaming
 * would touch this file's only other importer (`chat/dto/chat-payloads.ts`)
 * for a purely cosmetic diff. `MessagingCoreService.postMessage` is what
 * actually enforces which fields a given `kind` requires — this DTO only
 * bounds each field's shape when present.
 */
export class GifAttachmentDto {
  @IsString() @MinLength(1) @MaxLength(2048) url!: string;

  // `kind:'gif'` / `kind:'image'` only.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2048) previewUrl?: string;
  @IsOptional() @IsInt() @Min(1) width?: number;
  @IsOptional() @IsInt() @Min(1) height?: number;

  // `kind:'document'` only. `fileName` is member-supplied DISPLAY text —
  // bounded and control-character-stripped server-side (see
  // `MessagingCoreService.sanitizeDisplayFileName`), never used to build a
  // storage key or a served header.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(255) fileName?: string;
  @IsOptional() @IsInt() @Min(1) byteSize?: number;
  @IsOptional() @IsString() @MaxLength(128) contentType?: string;

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
   *  photo, `'document'` a member-uploaded PDF/spreadsheet/text file (PRD-226)
   *  — all three require `attachment`; default/absent is an ordinary text
   *  bubble. */
  @IsOptional()
  @IsIn(['user', 'gif', 'image', 'document'])
  kind?: 'user' | 'gif' | 'image' | 'document';

  /** The media attachment for a `kind:'gif'`, `kind:'image'`, or
   *  `kind:'document'` send. Ignored for text. */
  @IsOptional()
  @ValidateNested()
  @Type(() => GifAttachmentDto)
  attachment?: GifAttachmentDto;
}
