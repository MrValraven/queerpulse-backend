import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A message pinned within a conversation — SHARED state both participants see.
 * A join table (rather than columns on `messages`) so a pin is an explicit
 * relationship with its own audit (`pinnedBy`/`pinnedAt`) and the model
 * generalises to group threads later without a schema change. Either DM
 * participant may create/remove a row; UNIQUE(conversation, message) makes
 * pin/unpin idempotent.
 */
@Entity('conversation_pinned_messages')
@Unique('UQ_conversation_pinned_messages', ['conversationId', 'messageId'])
export class ConversationPinnedMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_conversation_pinned_messages_conversation_id')
  @Column({ type: 'uuid' })
  conversationId: string;

  @Index('IDX_conversation_pinned_messages_message_id')
  @Column({ type: 'uuid' })
  messageId: string;

  /** The participant who pinned it. */
  @Column({ type: 'uuid' })
  pinnedBy: string;

  @CreateDateColumn({ type: 'timestamptz' })
  pinnedAt: Date;
}
