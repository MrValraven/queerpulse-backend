import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A participant's standing in a GROUP thread (feature #17). Every pre-group row
 * and both sides of a DM default to `member`; a group's creator is seeded as
 * `owner`. Phase 1 only SETS this column (creator = owner) — Phase 2 enforces
 * what each role may do (add/remove members, rename, promote/demote).
 */
export enum ConversationRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
}

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

  /**
   * Group standing. `member` for DMs and every pre-group row; a group creator is
   * `owner`. Set at creation in Phase 1; role-gated actions arrive in Phase 2.
   */
  @Column({
    type: 'enum',
    enum: ConversationRole,
    enumName: 'conversation_participants_role_enum',
    default: ConversationRole.Member,
  })
  role: ConversationRole;

  /**
   * When this participant LEFT a group. The row is kept (not deleted) so past
   * messages still resolve the member's identity and the system-message history
   * ("Cy left") stays intact. NULL = still an active member. A left member keeps
   * read access to history but is blocked from sending.
   */
  @Column({ type: 'timestamptz', nullable: true })
  leftAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt: Date | null;

  /**
   * Delivered watermark: everything in this conversation created at-or-before
   * this instant has reached this participant's device (they acked receipt over
   * the socket, or fetched/read the thread). One rung below `lastReadAt` — read
   * implies delivered, so `markRead` advances both. Null until the first ack.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  clearedAt: Date | null;

  @Column({ type: 'boolean', default: false })
  muted: boolean;
}
