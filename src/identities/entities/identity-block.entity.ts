import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A member blocking a business, persona or company. This is deliberately a
 * separate table from `blocks`, which stays a user-to-user pair under
 * `UQ_blocks_pair`. Blocking Cafe Lisboa leaves its owner's personal account
 * reachable, and blocking that person leaves the business thread open,
 * because those are two different relationships.
 */
@Entity('identity_blocks')
@Unique('UQ_identity_blocks_pair', ['blockerUserId', 'identityId'])
export class IdentityBlock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_identity_blocks_blocker_user_id')
  @Column({ type: 'uuid' })
  blockerUserId!: string;

  @Index('IDX_identity_blocks_identity_id')
  @Column({ type: 'uuid' })
  identityId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
