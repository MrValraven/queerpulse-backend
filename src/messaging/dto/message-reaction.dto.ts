import { IsIn } from 'class-validator';
import { MessageReactionKey } from '../entities/message-reaction.entity';

export class MessageReactionDto {
  @IsIn(Object.values(MessageReactionKey))
  key!: MessageReactionKey;
}
