import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { AmbassadorFocusArea } from '../ambassador-focus-areas';

/**
 * One grant of the QueerPulse Ambassador status. A revoke stamps the row
 * rather than deleting it, so a later re-grant is a new row and the history of
 * who granted and revoked it, and why, survives. At most one row per member is
 * active (`revoked_at IS NULL`), enforced by a partial unique index.
 */
@Entity('ambassadors')
@Index('UQ_ambassadors_active_user', ['userId'], {
  unique: true,
  where: '"revoked_at" IS NULL',
})
export class Ambassador {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_ambassadors_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_ambassadors_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 40 })
  focusArea!: AmbassadorFocusArea;

  @Column({ type: 'uuid', nullable: true })
  grantedById!: string | null;

  // SET NULL: erasing the granting staff member keeps the grant and its
  // history, with the actor shown as unknown.
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'granted_by_id',
    foreignKeyConstraintName: 'FK_ambassadors_granted_by',
  })
  grantedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt!: Date;

  /** Internal. Admin surfaces only. */
  @Column({ type: 'text' })
  grantReason!: string;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revokedById!: string | null;

  // SET NULL, same reason as `grantedBy` above.
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'revoked_by_id',
    foreignKeyConstraintName: 'FK_ambassadors_revoked_by',
  })
  revokedBy?: User | null;

  /** Internal. Admin surfaces only. */
  @Column({ type: 'text', nullable: true })
  revokeReason!: string | null;
}
