import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { StudioRelease } from './studio-release.entity';

export interface StudioCredit {
  name: string;
  role: string;
}

/**
 * One track of a Studio release. `(release_id, position)` is unique and
 * DEFERRABLE INITIALLY IMMEDIATE, so a reorder or a delete moves every
 * position in one statement and Postgres checks the set at statement end.
 * `audio_key` is unique while set, so one object never backs two tracks.
 * Migration `1830900000000-AddStudio`.
 */
@Entity('studio_tracks')
@Unique('UQ_studio_tracks_release_position', ['releaseId', 'position'], {
  deferrable: 'INITIALLY IMMEDIATE',
})
@Check('CHK_studio_tracks_position', `"position" >= 1`)
export class StudioTrack {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_tracks',
  })
  id!: string;

  @Column({ type: 'uuid' })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_tracks_release',
  })
  release?: StudioRelease;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Index('UQ_studio_tracks_audio_key', {
    unique: true,
    where: '"audio_key" IS NOT NULL',
  })
  @Column({ type: 'varchar', nullable: true })
  audioKey!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  audioContentType!: string | null;

  @Column({ type: 'integer', nullable: true })
  audioBytes!: number | null;

  @Column({ type: 'integer', nullable: true })
  durationSeconds!: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  credits!: StudioCredit[];

  @Column({ type: 'text', nullable: true })
  lyrics!: string | null;

  @Column({ type: 'boolean', default: false })
  isExplicit!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
