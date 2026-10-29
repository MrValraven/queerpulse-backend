import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * A member's request for Studio access (contract 6.6). `isFromInvite` is true
 * for the rows an invite or a `studio_artist` join request files for the
 * member (contract 13). The queue index (`wants_to_release DESC`,
 * `created_at ASC`, `id ASC`) lives in the migration.
 */
@Entity('studio_access_requests')
@Unique('UQ_studio_access_requests_user', ['userId'])
@Index('IDX_studio_access_requests_queue', { synchronize: false })
export class StudioAccessRequest {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_access_requests',
  })
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_access_requests_user',
  })
  user?: User;

  @Column({ type: 'boolean', default: false })
  wantsToRelease!: boolean;

  @Column({ type: 'boolean', default: false })
  isFromInvite!: boolean;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;
}
