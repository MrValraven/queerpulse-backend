import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum SubprofileKind {
  Developer = 'developer',
  Writer = 'writer',
  Musician = 'musician',
  VisualArtist = 'visual_artist',
  Filmmaker = 'filmmaker',
  Designer = 'designer',
  Maker = 'maker',
  Drag = 'drag',
  Dj = 'dj',
  Dancer = 'dancer',
  Performer = 'performer',
  Photographer = 'photographer',
  Videomaker = 'videomaker',
  Chef = 'chef',
  Mixologist = 'mixologist',
  Therapist = 'therapist',
  Generic = 'generic',
}

export enum SubprofileLinkVisibility {
  Linked = 'linked',
  Unlinked = 'unlinked',
}

// Reuses the `open | network | private` values of the main profile's
// visibility, but under its own enum name so it evolves independently.
export enum SubprofileVisibility {
  Open = 'open',
  Network = 'network',
  Private = 'private',
}

export enum SubprofileStatus {
  Draft = 'draft',
  Published = 'published',
}

@Entity('subprofiles')
@Index('IDX_subprofiles_directory', ['kind', 'status', 'visibility'])
@Index('UQ_subprofiles_user_slug', ['userId', 'slug'], { unique: true })
export class Subprofile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_subprofiles_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    type: 'enum',
    enum: SubprofileKind,
    enumName: 'subprofiles_kind_enum',
  })
  kind!: SubprofileKind;

  // Per-owner unique — the nested URL `/members/<main>/<slug>`.
  @Column({ type: 'varchar' })
  slug!: string;

  // Globally unique when set; the `/p/<handle>` handle for unlinked+published.
  @Index('UQ_subprofiles_handle', {
    unique: true,
    where: '"handle" IS NOT NULL',
  })
  @Column({ type: 'varchar', nullable: true })
  handle!: string | null;

  @Column({ type: 'varchar' })
  displayName!: string;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  tagline!: string | null;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'varchar', nullable: true })
  coverUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  accent!: string | null; // curated palette key

  @Column({ type: 'varchar', nullable: true })
  availability!: string | null; // AVAILABILITY_KEYS

  @Column({ type: 'varchar', nullable: true })
  ctaLabel!: string | null;

  @Column({ type: 'varchar', nullable: true })
  ctaUrl!: string | null;

  @Column({
    type: 'enum',
    enum: SubprofileLinkVisibility,
    enumName: 'subprofiles_link_visibility_enum',
    default: SubprofileLinkVisibility.Linked,
  })
  linkVisibility!: SubprofileLinkVisibility;

  @Column({
    type: 'enum',
    enum: SubprofileVisibility,
    enumName: 'subprofiles_visibility_enum',
    default: SubprofileVisibility.Open,
  })
  visibility!: SubprofileVisibility;

  @Column({
    type: 'enum',
    enum: SubprofileStatus,
    enumName: 'subprofiles_status_enum',
    default: SubprofileStatus.Draft,
  })
  status!: SubprofileStatus;

  // Ordering under the main profile.
  @Column({ type: 'int', default: 0 })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
