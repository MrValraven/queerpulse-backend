import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
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

  /** ENG-407: client-generated idempotency key (`crypto.randomUUID()`), the
   *  same key `SendMessageDto.clientMessageId` carries. Used when the pair is
   *  already connected and the body lands as an ordinary message: a retried
   *  request with the same key returns the stored message and posts nothing
   *  new. The unconnected branch seeds a connection request and ignores it. */
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}
