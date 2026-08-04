import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A per-user bookmark ("star") on a message — PRIVATE by construction: every
 * read filters on `userId`, so one member's stars are never visible to the
 * other participant. UNIQUE(user, message) makes star/unstar idempotent.
 */
@Entity('message_stars')
@Unique('UQ_message_stars', ['userId', 'messageId'])
export class MessageStar {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_message_stars_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Index('IDX_message_stars_message_id')
  @Column({ type: 'uuid' })
  messageId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
