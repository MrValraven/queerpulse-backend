import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

export enum StudioReleaseType {
  Album = 'album',
  Ep = 'ep',
  Single = 'single',
  Mix = 'mix',
}

export enum StudioReleaseStatus {
  Draft = 'draft',
  Published = 'published',
  TakenDown = 'taken_down',
}

/**
 * A Studio release, owned by a musician or DJ persona. `subprofile_id`
 * cascades on update so the row follows the persona to the fresh id an
 * unlink gives it, and on delete so a deleted persona takes its releases
 * along. `published_at` is millisecond precision: it is the home feed's
 * keyset cursor and is only ever written from a JS `Date`.
 * Migration `1830900000000-AddStudio`.
 */
@Entity('studio_releases')
@Index('IDX_studio_releases_status_published_at', [
  'status',
  'publishedAt',
  'id',
])
@Index('IDX_studio_releases_subprofile_status', ['subprofileId', 'status'])
@Check(
  'CHK_studio_releases_published_at',
  `"status" <> 'published' OR "published_at" IS NOT NULL`,
)
export class StudioRelease {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_releases',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_releases_subprofile',
  })
  subprofile?: Subprofile;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({
    type: 'enum',
    enum: StudioReleaseType,
    enumName: 'studio_releases_type_enum',
  })
  type!: StudioReleaseType;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  genre!: string | null;

  /** A persona-scoped image key (`persona/<uuid>/<uuid><ext>`). */
  @Index('IDX_studio_releases_cover_key', { where: '"cover_key" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  coverKey!: string | null;

  /** `YYYY-MM-DD`; TypeORM hands a `date` column back as a string. */
  @Column({ type: 'date', nullable: true })
  releasedOn!: string | null;

  @Column({
    type: 'enum',
    enum: StudioReleaseStatus,
    enumName: 'studio_releases_status_enum',
    default: StudioReleaseStatus.Draft,
  })
  status!: StudioReleaseStatus;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  rightsConfirmedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  takenDownAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  takenDownById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'taken_down_by_id',
    foreignKeyConstraintName: 'FK_studio_releases_taken_down_by',
  })
  takenDownBy?: User | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  takedownReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
