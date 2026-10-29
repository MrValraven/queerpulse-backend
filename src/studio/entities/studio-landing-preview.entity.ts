import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  STUDIO_LANDING_PREVIEW_STATUSES,
  StudioLandingPreviewStatus,
} from '../studio.constants';
import { StudioTrack } from './studio-track.entity';

/**
 * A track offered as a public preview on the Studio page (contract 6.1). A
 * row needs an owner's yes before it goes live, and the read drops it again
 * by the eligibility rules at request time. One open row (`pending` or
 * `approved`) per track; `decidedById` and `decidedAt` hold the latest owner
 * action and never reach an owner or public payload.
 */
@Entity('studio_landing_previews')
@Check('CHK_studio_landing_previews_position', '"position" >= 1')
@Index('UQ_studio_landing_previews_open_track', ['trackId'], {
  unique: true,
  where: `"status" IN ('pending', 'approved')`,
})
@Index('IDX_studio_landing_previews_status_position', ['status', 'position'])
export class StudioLandingPreview {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_landing_previews',
  })
  id!: string;

  @Column({ type: 'uuid' })
  trackId!: string;

  @ManyToOne(() => StudioTrack, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_landing_previews_track',
  })
  track?: StudioTrack;

  @Column({
    type: 'enum',
    enum: STUDIO_LANDING_PREVIEW_STATUSES,
    enumName: 'studio_landing_previews_status_enum',
    default: 'pending',
  })
  status!: StudioLandingPreviewStatus;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'uuid', nullable: true })
  requestedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'requested_by_id',
    foreignKeyConstraintName: 'FK_studio_landing_previews_requested_by',
  })
  requestedBy?: User | null;

  @Column({ type: 'uuid', nullable: true })
  decidedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'decided_by_id',
    foreignKeyConstraintName: 'FK_studio_landing_previews_decided_by',
  })
  decidedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  updatedAt!: Date;
}
