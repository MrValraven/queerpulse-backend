import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A hard, mutual severance placed by `blockerId` against `blockedId`
 * (spec §2/§3 Tier 1 "social"). Unlike `Connection`'s blocked status, this is
 * a standalone safety primitive with no bearing on connection state — a
 * block can exist with or without a prior connection.
 */
@Entity('blocks')
@Unique('UQ_blocks_pair', ['blockerId', 'blockedId'])
export class Block {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_blocks_blocker_id')
  @Column({ type: 'uuid' })
  blockerId!: string;

  @Index('IDX_blocks_blocked_id')
  @Column({ type: 'uuid' })
  blockedId!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /**
   * PRD-423: the matched Go together chat this block was placed from, by
   * per-chat member key or from the group sheet; null for every ordinary
   * block. The blocker knew that member by first name alone, so the block
   * list names such a row by first name, with no slug, and unblocks it by
   * id. No foreign key, so a deleted chat leaves the row anonymous.
   */
  @Column({ type: 'uuid', nullable: true })
  matchedConversationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
