import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A per-user "delete for me" on a message (PRD-227) — PRIVATE by construction,
 * mirroring `MessageStar`'s exact shape: every read filters on `userId`, so
 * hiding a message never changes what the OTHER participant sees, and never
 * tombstones it for them. This sits BESIDE the existing "delete for everyone"
 * tombstone (`Message.deletedAt`, author-or-staff) — the two never merge:
 * a message can be hidden for one viewer, tombstoned for everyone, both, or
 * neither, independently. UNIQUE(user, message) makes hide idempotent (no
 * "unhide" is offered from the UI, matching WhatsApp/Telegram).
 */
@Entity('message_hides')
@Unique('UQ_message_hides', ['userId', 'messageId'])
export class MessageHide {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_message_hides_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Index('IDX_message_hides_message_id')
  @Column({ type: 'uuid' })
  messageId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
