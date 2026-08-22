import { IsString, MaxLength, MinLength } from 'class-validator';
import { TrimMessageBody } from './trim-message-body';

export class EditMessageDto {
  @TrimMessageBody()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}
