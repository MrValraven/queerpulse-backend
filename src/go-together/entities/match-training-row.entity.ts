import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ComponentScores } from '../go-together-scoring';

/** De-identified tuning data: one rated pair's component scores and whether
 *  both said Yes. No user, group or event ids, on purpose. */
@Entity('match_training_rows')
export class MatchTrainingRow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'int' })
  scoringVersion!: number;

  @Column({ type: 'jsonb' })
  components!: ComponentScores;

  @Column({ type: 'boolean' })
  mutualYes!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
