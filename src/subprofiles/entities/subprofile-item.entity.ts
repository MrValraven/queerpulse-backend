import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Shared skin-field types (Personas redesign Phase 0). Kept in lockstep with
// the frontend mirror in `subprofiles.api.ts` (design plan "Shared Contract").
export type GigState = 'sold_out' | 'cancelled' | 'guest';
export type WorkState = 'shipped' | 'archived' | 'in_progress';
export interface MenuDish {
  title: string;
  note?: string | null;
  marks?: string[] | null;
}
export interface MenuCourse {
  n: string;
  name: string;
  dishes: MenuDish[];
}
/** Nested per-item data that doesn't fit flat columns (subprofile_items.structured). */
export interface ItemStructured {
  courses?: MenuCourse[] | null;
  snippet?: string[] | null;
}

// Union of every kind's content sections plus the universal `links` section.
// Kept in lockstep with `KIND_SECTIONS` in `../subprofile-kinds.ts`.
export enum SubprofileSection {
  // developer
  Projects = 'projects',
  OpenSource = 'open_source',
  // writer
  Publications = 'publications',
  Readings = 'readings',
  // musician
  Discography = 'discography',
  Gigs = 'gigs',
  // visual_artist
  Portfolio = 'portfolio',
  Exhibitions = 'exhibitions',
  // filmmaker
  Filmography = 'filmography',
  Screenings = 'screenings',
  // designer
  SelectedWork = 'selected_work',
  Clients = 'clients',
  // maker
  Collections = 'collections',
  Workshops = 'workshops',
  // drag
  Shows = 'shows',
  Looks = 'looks',
  // dj
  Mixes = 'mixes',
  // dancer + performer
  Performances = 'performances',
  Reel = 'reel',
  // performer
  Appearances = 'appearances',
  // photographer
  Series = 'series',
  // videomaker
  Videos = 'videos',
  // chef
  Menus = 'menus',
  // chef + mixologist
  Residencies = 'residencies',
  // mixologist
  Cocktails = 'cocktails',
  // therapist
  Specialisms = 'specialisms',
  Credentials = 'credentials',
  // generic
  Showcase = 'showcase',
  // every kind
  Links = 'links',
}

@Entity('subprofile_items')
export class SubprofileItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_subprofile_items_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Column({
    type: 'enum',
    enum: SubprofileSection,
    enumName: 'subprofile_items_section_enum',
  })
  section!: SubprofileSection;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar', nullable: true })
  subtitle!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', nullable: true })
  url!: string | null;

  @Column({ type: 'varchar', nullable: true })
  imageUrl!: string | null;

  // Freeform, e.g. "2025".
  @Column({ type: 'varchar', nullable: true })
  date!: string | null;

  // Short supporting line (role, stars, client, …).
  @Column({ type: 'varchar', nullable: true })
  meta!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  collaborators!: string[];

  @Column({ type: 'boolean', default: false })
  isFeatured!: boolean;

  @Column({ type: 'int', default: 0 })
  position!: number;

  // --- Personas redesign Phase 0: skin-specific flat scalars + nested jsonb --
  // (design plan "Shared Contract"). Only populated for sections/kinds the
  // relevant skin cares about; null everywhere else.

  @Column({ type: 'varchar', length: 200, nullable: true })
  venue!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  doors!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  ticketUrl!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  gigState!: GigState | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  medium!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  dimensions!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  edition!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  workState!: WorkState | null;

  @Column({ type: 'jsonb', nullable: true })
  structured!: ItemStructured | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
