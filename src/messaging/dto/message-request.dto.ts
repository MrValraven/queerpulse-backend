import { IsString, MaxLength, MinLength } from 'class-validator';
import { TrimMessageBody } from './trim-message-body';

export class MessageRequestDto {
  // Same bound as `CreateConnectionDto.toSlug`: an unconnected request is
  // handed to `ConnectionsService.requestConnection` with this value.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  toSlug!: string;

  @TrimMessageBody()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}
