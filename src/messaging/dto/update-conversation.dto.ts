import { IsBoolean } from 'class-validator';

export class UpdateConversationDto {
  @IsBoolean()
  muted: boolean;
}
