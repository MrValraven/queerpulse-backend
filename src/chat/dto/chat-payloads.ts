import {
  IsBoolean,
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
