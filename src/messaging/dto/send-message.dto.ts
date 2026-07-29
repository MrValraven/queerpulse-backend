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

export class GifAttachmentDto {
  @IsUrl() url: string;
  @IsUrl() previewUrl: string;
  @IsInt() @Min(1) width: number;
  @IsInt() @Min(1) height: number;
  // Free-form (bounded) so swapping the GIF provider never needs a DTO change.
  @IsString() @MaxLength(32) provider: string;
}

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;

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
   *  still goes through the ordinary idempotent send path. */
  @IsOptional()
  @IsBoolean()
  forwarded?: boolean;

  /** `'gif'` marks this send as a provider GIF (requires `attachment`); default/
   *  absent is an ordinary text bubble. */
  @IsOptional()
  @IsIn(['user', 'gif'])
  kind?: 'user' | 'gif';

  /** The provider-hosted GIF for a `kind:'gif'` send. Ignored for text. */
  @IsOptional()
  @ValidateNested()
  @Type(() => GifAttachmentDto)
  attachment?: GifAttachmentDto;
}
