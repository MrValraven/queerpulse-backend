import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioRelease } from './studio-release.entity';

/**
 * Studio v3 "Notify me": a member waiting for a scheduled release. The drop
 * consumes the rows in the same statement that claims the alert
 * (`RELEASE_ALERT_CLAIM_SQL`), so each holder hears once. `release_id`
 * cascades on update because an unlink gives the persona's releases fresh
 * ids (the unlink then deletes these rows). `IDX_..._user_id` serves account
 * erasure and the data export.
 * Migration `1832000100000-AddStudioArtistTools`.
 */
@Entity('studio_release_reminders')
@Index('IDX_studio_release_reminders_user_id', ['userId'])
export class StudioReleaseReminder {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_studio_release_reminders',
  })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_release_reminders_release',
  })
  release?: StudioRelease;

  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_studio_release_reminders',
  })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_release_reminders_user',
  })
  user?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
