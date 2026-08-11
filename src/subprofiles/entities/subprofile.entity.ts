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

// Persona-level skin blocks (Personas redesign Phase 0, design plan "Shared
// Contract"). Kept in lockstep with the frontend mirror in
// `subprofiles.api.ts`. Only the keys relevant to the persona's derived skin
// (a pure function of `kind` — never stored) are populated.
export interface SkinData {
  /** Owner display preference: when true, the cover banner fades into the page
   *  background at its bottom edge instead of ending on a hard seam. Rendered
   *  by the frontend (`.pp[data-cover-bleed]`); the backend only stores it. */
  coverBleed?: boolean;
  booker?: {
    fee: string;
    rider: string;
    press: string;
    contact: string;
  } | null;
  excerpt?: { from: string; lines: string[] } | null;
  colophon?: string | null;
  menuMeta?: { no: string; when: string; practical: string[] } | null;
  practical?: {
    fee: string;
    sliding: string;
    length: string;
    languages: string;
    mode: string;
    next: string;
  } | null;
  firstSession?: { title: string; body: string }[] | null;
  access?: string[] | null;
  referrals?: { name: string; note: string }[] | null;
}

@Entity('subprofiles')
@Index('IDX_subprofiles_directory', ['kind', 'status', 'visibility'])
// Directory/search hot path: `directory()`/`searchByText()` filter on
// (linkVisibility, status, visibility) with `handle IS NOT NULL` +
// `removed_at IS NULL`, then order by `display_name`. A partial composite index
// over exactly that predicate + sort key serves the equality filters and the
// ordered scan without touching draft/nested/removed rows. See migration
// `AddSubprofileDirectoryBrowseIndex1787700200000`.
@Index(
  'IDX_subprofiles_directory_browse',
  ['linkVisibility', 'status', 'visibility', 'displayName'],
  { where: '"handle" IS NOT NULL AND "removed_at" IS NULL' },
)
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

  // Globally unique when set AND published; the `/p/<handle>` handle for
  // unlinked+published personas. The partial predicate is scoped to
  // `status = 'published'` so a DRAFT can hold a desired handle without
  // reserving it against the global namespace — two drafts may name the same
  // handle, and only the FIRST to publish claims it (publish-time
  // `HandlesService.isTaken`/`rename` still enforces global uniqueness across
  // published personas + main usernames). See migration
  // `NarrowSubprofileHandleUniqueIndexToPublished1787700100000`.
  @Index('UQ_subprofiles_handle', {
    unique: true,
    where: `"handle" IS NOT NULL AND "status" = 'published'`,
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

  // Personas redesign Phase 0: persona-level skin display blocks (see
  // `SkinData` above). Display data only — present on the public view too.
  @Column({ type: 'jsonb', nullable: true })
  skinData!: SkinData | null;

  // Personas redesign Phase 1b: set = this persona is withheld from every
  // non-owner public read as `403 { restrictedState: "removed" }` (see
  // `SubprofilesService`'s `resolvePublicAccess`/`buildPublicView`). Nothing
  // sets this column yet — the admin takedown action that would is a separate,
  // later moderation-console feature (Phase 1b's Non-goals); for now it is
  // DB-settable only.
  @Column({ type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
