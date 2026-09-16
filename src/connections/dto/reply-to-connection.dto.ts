import { IsString, MaxLength, MinLength } from 'class-validator';
import { TrimMessageBody } from '../../messaging/dto/trim-message-body';

/**
 * `PATCH /connections/:id/reply` (PRD-340): reply-implies-accept. Same body
 * shape and bound as `MessageRequestDto.body`: the addressee's own reply to
 * a stranger's pending message request, accepted and delivered in one call.
 */
export class ReplyToConnectionDto {
  @TrimMessageBody()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}
