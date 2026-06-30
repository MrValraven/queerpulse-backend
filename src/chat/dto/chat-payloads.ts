import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

export class JoinPayload {
  @IsString()
  conversationId: string;
}

export class SendMessagePayload {
  @IsString()
  conversationId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class TypingPayload {
  @IsString()
  conversationId: string;

  @IsBoolean()
  isTyping: boolean;
}

export class ReadPayload {
  @IsString()
  conversationId: string;
}
