import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GifAttachmentDto } from '../../messaging/dto/send-message.dto';
import { TrimMessageBody } from '../../messaging/dto/trim-message-body';

export class JoinPayload {
  @IsUUID('4')
  conversationId!: string;
}

export class SendMessagePayload {
  @IsUUID('4')
  conversationId!: string;

  @TrimMessageBody()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsUUID('4')
  replyToId?: string;

  /** Client-generated idempotency key — dedupes against the HTTP POST path and
   *  any retry (see MessagingService.postMessage). */
  @IsOptional()
  @IsUUID('4')
  clientMessageId?: string;

  @IsOptional()
  @IsIn(['user', 'gif', 'image'])
  kind?: 'user' | 'gif' | 'image';

  @IsOptional()
  @ValidateNested()
  @Type(() => GifAttachmentDto)
  attachment?: GifAttachmentDto;
}

export class TypingPayload {
  @IsUUID('4')
  conversationId!: string;

  @IsBoolean()
  isTyping!: boolean;
}

export class ReadPayload {
  @IsUUID('4')
  conversationId!: string;

  /** The newest message this client has actually rendered. The server reads
   *  that row's own `created_at` and stamps the watermark there, so a message
   *  that arrived between the last fetch and this frame is not silently marked
   *  read. Omitted, the watermark stays `now()` (the original behaviour). */
  @IsOptional()
  @IsUUID('4')
  upToMessageId?: string;
}

export class DeliveredPayload {
  @IsUUID('4')
  conversationId!: string;
}
