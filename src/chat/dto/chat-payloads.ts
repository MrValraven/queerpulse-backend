import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class JoinPayload {
  @IsUUID('4')
  conversationId: string;
}

export class SendMessagePayload {
  @IsUUID('4')
  conversationId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;

  @IsOptional()
  @IsUUID('4')
  replyToId?: string;

  /** Client-generated idempotency key — dedupes against the HTTP POST path and
   *  any retry (see MessagingService.postMessage). */
  @IsOptional()
  @IsUUID('4')
  clientMessageId?: string;
}

export class TypingPayload {
  @IsUUID('4')
  conversationId: string;

  @IsBoolean()
  isTyping: boolean;
}

export class ReadPayload {
  @IsUUID('4')
  conversationId: string;
}

export class DeliveredPayload {
  @IsUUID('4')
  conversationId: string;
}
