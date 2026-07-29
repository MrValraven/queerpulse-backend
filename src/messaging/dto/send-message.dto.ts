import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

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
}
