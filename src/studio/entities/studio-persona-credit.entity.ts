import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';
import { StudioTrack } from './studio-track.entity';

export enum StudioPersonaCreditState {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

/**
 * Studio discovery: a persona credited on a track. The release's persona
 * requests it; any member of the credited persona accepts or declines it.
 * Both subprofile foreign keys cascade on delete and on update, the way
 * `FK_studio_releases_subprofile` does (the unlink tripwire
 * `persona-foreign-keys.spec.ts` reads them). The track key cascades on
 * update too, since an unlink gives the persona's tracks fresh ids.
 * `requested_by_user_id` serves the audit and the block filter and stays
 * off every wire. `requester_dismissed_at` takes a declined row off the
 * requester's list while it keeps blocking a repeat request.
 * Migration `1831800000000-AddStudioDiscovery`.
 */
@Entity('studio_persona_credits')
@Unique('UQ_studio_persona_credits_track_subprofile_role', [
  'trackId',
  'subprofileId',
  'role',
])
@Index('IDX_studio_persona_credits_subprofile_status', [
  'subprofileId',
  'status',
])
@Index('IDX_studio_persona_credits_track_id', ['trackId'])
@Index('IDX_studio_persona_credits_requested_by_subprofile_id', [
  'requestedBySubprofileId',
])
@Index('IDX_studio_persona_credits_requested_by_user_id', ['requestedByUserId'])
export class StudioPersonaCredit {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_persona_credits',
  })
  id!: string;

  @Column({ type: 'uuid' })
  trackId!: string;

  @ManyToOne(() => StudioTrack, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_persona_credits_track',
  })
  track?: StudioTrack;

  /** The credited persona. */
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_persona_credits_subprofile',
  })
  subprofile?: Subprofile;

  /** One of `STUDIO_CREDIT_ROLES`, checked by the request body. */
  @Column({ type: 'varchar', length: 20 })
  role!: string;

  @Column({
    type: 'enum',
    enum: StudioPersonaCreditState,
    enumName: 'studio_persona_credits_status_enum',
    default: StudioPersonaCreditState.Pending,
  })
  status!: StudioPersonaCreditState;

  /** The release's persona at request time. */
  @Column({ type: 'uuid' })
  requestedBySubprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'requested_by_subprofile_id',
    foreignKeyConstraintName:
      'FK_studio_persona_credits_requested_by_subprofile',
  })
  requestedBySubprofile?: Subprofile;

  @Column({ type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'FK_studio_persona_credits_requested_by_user',
  })
  requestedByUser?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  requesterDismissedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
