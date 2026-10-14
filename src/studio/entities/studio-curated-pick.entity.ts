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
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioRelease } from './studio-release.entity';

export enum StudioCuratedPickShelf {
  Featured = 'featured',
  StaffPicks = 'staff_picks',
  NewThisWeek = 'new_this_week',
}

/**
 * Studio discovery: one release on a staff shelf, with an optional one-line
 * note. `(shelf, position)` is unique and DEFERRABLE INITIALLY IMMEDIATE, so
 * a reorder or a remove rewrites positions in one statement. The release
 * foreign key cascades on delete and on update (a persona unlink re-keys
 * releases; `forgetDiscoveryTiesOfPersona` deletes the picks first).
 * `created_by_id` stays off the member wire. Migration
 * `1831800000000-AddStudioDiscovery`.
 */
@Entity('studio_curated_picks')
@Unique('UQ_studio_curated_picks_shelf_release', ['shelf', 'releaseId'])
@Unique('UQ_studio_curated_picks_shelf_position', ['shelf', 'position'], {
  deferrable: 'INITIALLY IMMEDIATE',
})
@Check('CHK_studio_curated_picks_position', `"position" >= 1`)
@Index('IDX_studio_curated_picks_release_id', ['releaseId'])
export class StudioCuratedPick {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_curated_picks',
  })
  id!: string;

  @Column({
    type: 'enum',
    enum: StudioCuratedPickShelf,
    enumName: 'studio_curated_picks_shelf_enum',
  })
  shelf!: StudioCuratedPickShelf;

  @Column({ type: 'uuid' })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_curated_picks_release',
  })
  release?: StudioRelease;

  @Column({ type: 'varchar', length: 140, nullable: true })
  note!: string | null;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_studio_curated_picks_created_by',
  })
  createdBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
