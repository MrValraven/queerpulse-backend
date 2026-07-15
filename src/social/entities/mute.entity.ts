import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A one-way, soft silence placed by `muterId` against `mutedId` (spec §2/§3
 * Tier 1 "social"). The muted member is never notified and never learns they
 * were muted — nothing here is ever surfaced to them.
 */
@Entity('mutes')
@Unique('UQ_mutes_pair', ['muterId', 'mutedId'])
export class Mute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_mutes_muter_id')
  @Column({ type: 'uuid' })
  muterId: string;

  @Index('IDX_mutes_muted_id')
  @Column({ type: 'uuid' })
  mutedId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
