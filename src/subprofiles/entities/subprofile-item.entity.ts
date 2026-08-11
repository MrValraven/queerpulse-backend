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
  // Per-item social links stored in the `structured` jsonb blob (no dedicated
  // column). Shape mirrors the persona-level SubprofileSocialLink.
  links?: { platform: string; urlOrHandle: string }[] | null;
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
  // astrologer
  Charts = 'charts',
  Sky = 'sky',
  // generic
  Showcase = 'showcase',
  // every kind
  Gallery = 'gallery',
  Links = 'links',
  // Persona families + crafts expansion (migration
  // `AddPersonaFamiliesAndCrafts1787700400000`). Purely additive — 81 new
  // content sections spanning the 75 new kinds. Several are shared across kinds
  // (e.g. `pieces`, `events`, `treatments`, `services`, `campaigns`,
  // `resources`, `research`, `testimonies`, `finding_aids`, `productions`,
  // `aftercare`, `courses`, `papers`) and are declared exactly once. Kept in
  // lockstep with `KIND_SECTIONS` in `../subprofile-kinds.ts` and the FE mirror.
  Sets = 'sets',
  Tour = 'tour',
  Recordings = 'recordings',
  Acts = 'acts',
  Pieces = 'pieces',
  Hosted = 'hosted',
  Balls = 'balls',
  Flash = 'flash',
  Healed = 'healed',
  Books = 'books',
  Strips = 'strips',
  Games = 'games',
  Jams = 'jams',
  Models = 'models',
  Editions = 'editions',
  Reporting = 'reporting',
  Bylines = 'bylines',
  Poems = 'poems',
  Edited = 'edited',
  Scripts = 'scripts',
  Productions = 'productions',
  Translations = 'translations',
  Languages = 'languages',
  Zines = 'zines',
  Distros = 'distros',
  Papers = 'papers',
  Teaching = 'teaching',
  Wares = 'wares',
  Firings = 'firings',
  Commissions = 'commissions',
  Builds = 'builds',
  Arrangements = 'arrangements',
  Events = 'events',
  Analyses = 'analyses',
  Programmes = 'programmes',
  Treatments = 'treatments',
  Classes = 'classes',
  Trainings = 'trainings',
  Support = 'support',
  Training = 'training',
  Resources = 'resources',
  Groups = 'groups',
  Bakes = 'bakes',
  Markets = 'markets',
  Brews = 'brews',
  Releases = 'releases',
  Taprooms = 'taprooms',
  Lists = 'lists',
  Pairings = 'pairings',
  Services = 'services',
  Cuts = 'cuts',
  NailSets = 'nail_sets',
  Aftercare = 'aftercare',
  Piercings = 'piercings',
  Editorials = 'editorials',
  Book = 'book',
  Campaigns = 'campaigns',
  Sketches = 'sketches',
  Texts = 'texts',
  Programme = 'programme',
  Artists = 'artists',
  Available = 'available',
  Advisory = 'advisory',
  FindingAids = 'finding_aids',
  Loans = 'loans',
  Installations = 'installations',
  Reviews = 'reviews',
  Tours = 'tours',
  Talks = 'talks',
  Installs = 'installs',
  Research = 'research',
  Lectures = 'lectures',
  Testimonies = 'testimonies',
  Findings = 'findings',
  Sites = 'sites',
  Actions = 'actions',
  Writing = 'writing',
  Nights = 'nights',
  Roster = 'roster',
  Courses = 'courses',
  Subjects = 'subjects',
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
