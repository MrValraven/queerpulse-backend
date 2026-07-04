import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('conversation_participants')
@Unique('UQ_conversation_participants', ['conversationId', 'userId'])
export class ConversationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_conversation_participants_conversation_id')
  @Column({ type: 'uuid' })
  conversationId: string;

  @Index('IDX_conversation_participants_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt: Date | null;

  @Column({ type: 'boolean', default: false })
  muted: boolean;
}
