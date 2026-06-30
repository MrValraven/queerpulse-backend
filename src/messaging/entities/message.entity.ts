import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_messages_conversation_id')
  @Column({ type: 'uuid' })
  conversationId: string;

  @Column({ type: 'uuid' })
  senderId: string;

  @Column({ type: 'text' })
  body: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt: Date | null;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;
}
