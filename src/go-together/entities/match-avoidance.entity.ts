import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/** A private, permanent "Not for me". Read in both directions as a hard filter. */
@Entity('match_avoidances')
@Unique('UQ_match_avoidances_pair', ['userId', 'avoidedUserId'])
export class MatchAvoidance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Index('IDX_match_avoidances_avoided_user_id')
  @Column({ type: 'uuid' })
  avoidedUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
