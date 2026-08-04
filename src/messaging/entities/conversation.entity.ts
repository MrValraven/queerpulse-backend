import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Discriminates a 1:1 DM from a multi-party group thread (feature #17). Existing
 * rows default to `direct` in the migration, so every DM predating group chat
 * (and the official/welcome thread, which is `direct` + `isOfficial`) keeps its
 * exact behaviour. Orthogonal to `isOfficial`: an official thread is still a
 * `direct` kind — group is specifically the member-created, titled, N-member
 * thread. Phase 2 builds member management/roles on top of this.
 */
export enum ConversationKind {
  Direct = 'direct',
  Group = 'group',
}

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'boolean', default: false })
  isOfficial!: boolean;

  /**
   * `direct` (1:1 DM / official thread) or `group` (member-created, titled,
   * multi-participant). Defaults to `direct` so all pre-group rows are DMs.
   */
  @Column({
    type: 'enum',
    enum: ConversationKind,
    enumName: 'conversations_kind_enum',
    default: ConversationKind.Direct,
  })
  kind!: ConversationKind;

  /** Group name. NULL for DMs (their name is the counterpart's profile). */
  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  /** Group avatar (storage key/URL). NULL for DMs (counterpart's avatar). */
  @Column({ type: 'varchar', nullable: true })
  avatarUrl!: string | null;

  /**
   * The member who created a group (also seeded as its `owner` participant).
   * NULL for DMs and for groups whose creator's account was later deleted
   * (FK is `ON DELETE SET NULL`).
   */
  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  // Canonical sorted "userA:userB" key for 1:1 conversations — a UNIQUE guard
  // against duplicate threads under concurrent materialization. NULL for
  // official/group threads (Postgres treats NULLs as distinct in a UNIQUE index).
  @Index('UQ_conversations_pair_key', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  pairKey!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
