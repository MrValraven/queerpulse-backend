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

/**
 * One member's early access to one unlaunched feature. The row is the grant;
 * deleting it revokes. `featureKey` is a `FeatureKey` from
 * `src/launchedFeatures.ts`, stored as a plain varchar so a new early-access
 * feature needs no migration. `granted_by_id` is set null when the staff
 * account is erased. Migration `1836600000000-AddFeatureEarlyAccessGrants`.
 */
@Entity('feature_early_access_grants')
@Index(
  'UQ_feature_early_access_grants_user_feature',
  ['userId', 'featureKey'],
  { unique: true },
)
// The migration 1836600000000-AddFeatureEarlyAccessGrants.ts is authoritative: it creates this index with created_at DESC and id DESC, which TypeORM index metadata cannot express, so never regenerate it from the entity.
@Index('IDX_feature_early_access_grants_feature_created_at', [
  'featureKey',
  'createdAt',
  'id',
])
@Index('IDX_feature_early_access_grants_granted_by_id', ['grantedById'])
export class FeatureEarlyAccessGrant {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_feature_early_access_grants',
  })
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_feature_early_access_grants_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 64 })
  featureKey!: string;

  @Column({ type: 'uuid', nullable: true })
  grantedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'granted_by_id',
    foreignKeyConstraintName: 'FK_feature_early_access_grants_granted_by',
  })
  grantedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
