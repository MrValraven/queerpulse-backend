import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { GroupBand, GroupReason } from '../go-together-reasons';
import type { ComponentScores } from '../go-together-scoring';

/**
 * A formed group. `pairComponents` keeps each member pair's component scores
 * from formation time (keyed by `pairKey`) until the feedback window closes;
 * the cron then writes de-identified `match_training_rows` and nulls it.
 */
@Entity('event_match_groups')
export class EventMatchGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_match_groups_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Index('IDX_event_match_groups_conversation_id', {
    where: '"conversation_id" IS NOT NULL',
  })
  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  band!: GroupBand;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  reasons!: GroupReason[];

  @Column({ type: 'int' })
  scoringVersion!: number;

  @Column({ type: 'varchar', length: 80 })
  solverSeedLabel!: string;

  @Column({ type: 'jsonb', nullable: true })
  pairComponents!: Record<string, ComponentScores> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  formedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  dissolvedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  trainingWrittenAt!: Date | null;
}
