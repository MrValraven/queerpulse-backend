import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'boolean', default: false })
  isOfficial: boolean;

  // Canonical sorted "userA:userB" key for 1:1 conversations — a UNIQUE guard
  // against duplicate threads under concurrent materialization. NULL for
  // official/group threads (Postgres treats NULLs as distinct in a UNIQUE index).
  @Index('UQ_conversations_pair_key', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  pairKey: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
