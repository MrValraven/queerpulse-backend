import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum MessageReactionKey {
  Love = 'love',
  Laugh = 'laugh',
  Like = 'like',
  Wow = 'wow',
  Sad = 'sad',
  Thanks = 'thanks',
}

@Entity('message_reactions')
@Unique('UQ_message_reactions', ['messageId', 'userId', 'key'])
export class MessageReaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_message_reactions_message_id')
  @Column({ type: 'uuid' })
  messageId!: string;

  @Index('IDX_message_reactions_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: MessageReactionKey,
    enumName: 'message_reactions_key_enum',
  })
  key!: MessageReactionKey;
}
