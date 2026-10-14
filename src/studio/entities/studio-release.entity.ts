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
import { StudioScene } from './studio-scene.entity';

export enum StudioReleaseType {
  Album = 'album',
  Ep = 'ep',
  Single = 'single',
  Mix = 'mix',
  // Studio artist kinds. Migration
  // `1833000000000-AddStudioArtistKindEnumValues` appends the three labels
  // in this order. A podcast show's tracks are its episodes.
  Podcast = 'podcast',
  Edit = 'edit',
  LipSync = 'lip_sync',
}

export enum StudioReleaseStatus {
  Draft = 'draft',
  // Studio v3: waiting for `publish_at`. Migration
  // `1832000000000-AddStudioArtistToolsEnumValues` adds the label before
  // `published`, so the enum order matches this declaration.
  Scheduled = 'scheduled',
  Published = 'published',
  TakenDown = 'taken_down',
}

/**
 * A Studio release, owned by a persona of an artist kind (`STUDIO_FORMAT_BY_KIND`). `subprofile_id`
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
// Studio v2 browse by genre: the home feed filtered to one genre, in its own
// order. Partial on published rows, the only ones the feed reads.
// Migration `1831500100000-AddStudioReleaseFollowersNotifiedAt`.
@Index(
  'IDX_studio_releases_genre_published_at',
  ['genre', 'publishedAt', 'id'],
  {
    where: `"status" = 'published'`,
  },
)
// Studio discovery: browse by mood and the scene page, each in the feed's
// own order, partial on published rows. Migration
// `1831800000000-AddStudioDiscovery` builds both with `published_at DESC,
// id DESC`.
@Index('IDX_studio_releases_mood_published_at', ['mood', 'publishedAt', 'id'], {
  where: `"status" = 'published'`,
})
@Index(
  'IDX_studio_releases_scene_published_at',
  ['sceneId', 'publishedAt', 'id'],
  {
    where: `"status" = 'published'`,
  },
)
@Check(
  'CHK_studio_releases_published_at',
  `"status" <> 'published' OR "published_at" IS NOT NULL`,
)
// Studio v3: the once-a-minute drop reads due scheduled rows only.
// Migration `1832000100000-AddStudioArtistTools`.
@Index('IDX_studio_releases_publish_at', ['publishAt'], {
  where: `"status" = 'scheduled'`,
})
// One live preview link per release; a stored token is unique while set.
@Index('UQ_studio_releases_preview_token', ['previewToken'], {
  unique: true,
  where: '"preview_token" IS NOT NULL',
})
// A scheduled row always carries its time, and only a scheduled row does.
@Check(
  'CHK_studio_releases_publish_at',
  `("status" = 'scheduled') = ("publish_at" IS NOT NULL)`,
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

  /** Studio discovery: one of `STUDIO_MOODS`; a stored value outside the
   *  list reads as null on the wire. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  mood!: string | null;

  /** Studio discovery: the one scene the owner opted this release into. */
  @Column({ type: 'uuid', nullable: true })
  sceneId!: string | null;

  @ManyToOne(() => StudioScene, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'scene_id',
    foreignKeyConstraintName: 'FK_studio_releases_scene',
  })
  scene?: StudioScene | null;

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

  /**
   * Studio v2: when this release's followers were told about it. Claimed by
   * `StudioReleaseAlertsListener` with one conditional update, so a
   * republish, a restore or a repeated event never alerts twice.
   * Migration `1831500100000-AddStudioReleaseFollowersNotifiedAt`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  followersNotifiedAt!: Date | null;

  /**
   * Studio v3: when a scheduled release goes live. Set only while `status`
   * is `scheduled` (`CHK_studio_releases_publish_at`); the drop copies it to
   * `published_at` and clears it. Millisecond precision, since it becomes
   * the home feed's `published_at` cursor.
   * Migration `1832000100000-AddStudioArtistTools`.
   */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  publishAt!: Date | null;

  /** Studio v3: stamped by every track change made while the release is
   *  published, compared with the newest version note. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  tracksChangedAt!: Date | null;

  /** Studio v3: the private preview link, `randomBytes(32)` hex. Stored as
   *  is so the owner can copy the link again; owner-only on the wire. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  previewToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  previewLinkCreatedAt!: Date | null;

  /** Studio v3: an `https://` shop link for this release. Outbound only. */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  buyUrl!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
