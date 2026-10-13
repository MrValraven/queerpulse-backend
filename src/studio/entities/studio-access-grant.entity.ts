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
 * One member's Studio access (Studio v1). The row is the grant; deleting it
 * revokes. `granted_by_id` is set null when the staff account is erased.
 * Migration `1830900000000-AddStudio`.
 */
@Entity('studio_access_grants')
export class StudioAccessGrant {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_access_grants',
  })
  id!: string;

  @Index('UQ_studio_access_grants_user_id', { unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_access_grants_user',
  })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  grantedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'granted_by_id',
    foreignKeyConstraintName: 'FK_studio_access_grants_granted_by',
  })
  grantedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
