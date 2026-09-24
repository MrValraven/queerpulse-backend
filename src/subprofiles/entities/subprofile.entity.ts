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
  Astrologer = 'astrologer',
  Generic = 'generic',
  // Persona families + crafts expansion (migration
  // `AddPersonaFamiliesAndCrafts1787700400000`). Purely additive — 75 new kinds
  // across the existing families plus the six new families (chair, runway,
  // gallery, history, collective, classroom). Kept in lockstep with the FE
  // mirror in `subprofiles.api.ts` and `../subprofile-kinds.ts`.
  // stage
  Comedian = 'comedian',
  Vocalist = 'vocalist',
  Burlesque = 'burlesque',
  Circus = 'circus',
  SpokenWord = 'spoken_word',
  Host = 'host',
  Voguer = 'voguer',
  // studio
  Illustrator = 'illustrator',
  TattooArtist = 'tattoo_artist',
  Animator = 'animator',
  ComicArtist = 'comic_artist',
  GameDesigner = 'game_designer',
  Artist3d = 'artist_3d',
  Printmaker = 'printmaker',
  // page
  Journalist = 'journalist',
  Poet = 'poet',
  Editor = 'editor',
  Screenwriter = 'screenwriter',
  Translator = 'translator',
  Zinester = 'zinester',
  Academic = 'academic',
  // workshop
  Ceramicist = 'ceramicist',
  Jeweler = 'jeweler',
  TextileArtist = 'textile_artist',
  Woodworker = 'woodworker',
  Florist = 'florist',
  DataScientist = 'data_scientist',
  // practice
  Coach = 'coach',
  Bodyworker = 'bodyworker',
  YogaTeacher = 'yoga_teacher',
  Nutritionist = 'nutritionist',
  Doula = 'doula',
  PersonalTrainer = 'personal_trainer',
  SexEducator = 'sex_educator',
  PeerSupport = 'peer_support',
  // table
  Baker = 'baker',
  Barista = 'barista',
  Brewer = 'brewer',
  Sommelier = 'sommelier',
  Caterer = 'caterer',
  // chair (new family)
  HairStylist = 'hair_stylist',
  Barber = 'barber',
  MakeupArtist = 'makeup_artist',
  NailArtist = 'nail_artist',
  Esthetician = 'esthetician',
  Piercer = 'piercer',
  // runway (new family)
  FashionDesigner = 'fashion_designer',
  Stylist = 'stylist',
  Model = 'model',
  CostumeDesigner = 'costume_designer',
  // gallery (new family)
  Curator = 'curator',
  Gallerist = 'gallerist',
  ArtDealer = 'art_dealer',
  Archivist = 'archivist',
  Conservator = 'conservator',
  Registrar = 'registrar',
  ExhibitionDesigner = 'exhibition_designer',
  ArtCritic = 'art_critic',
  Docent = 'docent',
  Preparator = 'preparator',
  // history (new family — display name "Record")
  Historian = 'historian',
  ArtHistorian = 'art_historian',
  OralHistorian = 'oral_historian',
  Genealogist = 'genealogist',
  Heritage = 'heritage',
  ArchivalResearcher = 'archival_researcher',
  MemoryKeeper = 'memory_keeper',
  // collective (new family — display name "Poster")
  Organizer = 'organizer',
  Activist = 'activist',
  EventProducer = 'event_producer',
  Promoter = 'promoter',
  // classroom (new family)
  Teacher = 'teacher',
  Facilitator = 'facilitator',
  Tutor = 'tutor',
  Lecturer = 'lecturer',
  // stage (performer + teacher)
  PoleDancer = 'pole_dancer',
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

/** Practice skin (therapist): tri-state for one availability slot. */
export type PracticeAvailState = 'open' | 'full' | 'off';

/** Therapist layout: whether the therapist is taking new clients. */
export type TherapistStatus = 'open' | 'wait' | 'closed';

/** Therapist layout: online sessions offered. `''` means the therapist has
 *  not said either way. */
export type TherapistOnline = 'yes' | 'no' | '';

/** Therapist layout: the core facts shown in the hero and sidebar. Every
 *  string is owner-typed display text, stored as written. */
export interface TherapistFacts {
  status: TherapistStatus;
  /** Shown with status "wait", e.g. "About 6 weeks". */
  waitNote: string;
  /** e.g. "Clinical psychologist & psychotherapist". */
  title: string;
  /** e.g. "OPP 21044", exactly as the therapist states it. */
  registration: string;
  /** Hero pull-quote. `*word*` marks the coral italic emphasis. */
  quote: string;
  /** Comma-separated, e.g. "Portuguese, English, Spanish". */
  languages: string;
  /** e.g. "Arroios, Lisbon · and online". */
  where: string;
  online: TherapistOnline;
  /** Online-only time-zone note. May be "". */
  timezone: string;
  /** May be "". */
  email: string;
  /** May be "". */
  website: string;
  /** Conflict-of-interest / "good to know" note. May be "". */
  goodToKnow: string;
}

/** Therapist layout: fees and the small print. Amounts are euro digits as
 *  typed ("65"); the frontend view model parses them. */
export interface TherapyFees {
  standard: string;
  slidingMin: string;
  slidingMax: string;
  /** Total sliding-scale places, e.g. "4". */
  slidingPlaces: string;
  /** Sliding-scale places open right now, e.g. "2". */
  slidingOpen: string;
  slidingRules: string;
  /** e.g. "First 20-minute call is free". */
  firstContact: string;
  /** A fixed frequency choice ("weekly"), or older owner-typed text. */
  frequency: string;
  /** e.g. "Receipts for ADSE, Médis and Multicare reimbursement". */
  receipts: string;
  /** A fixed receipt-time choice ("within48h"), or older owner-typed text. */
  receiptTime: string;
  /** Fixed payment choices ("mbway", "card"), in the owner's order. Absent
   *  on older rows; when empty, the `payment` text is shown instead. */
  paymentMethods?: string[];
  /** Older owner-typed payment text, e.g. "MB Way, transfer or card". */
  payment: string;
  /** A fixed cancellation-notice choice ("24h"). Absent on older rows. */
  cancellationNotice?: string;
  /** Free-text note shown after the notice, e.g. "Less than that and the
   *  session is charged". */
  cancellation: string;
}

/** Therapist layout: how soon a first session can happen. */
export interface TherapistAvailabilitySummary {
  /** Time to a first session, e.g. "Within 2 weeks". */
  headline: string;
  /** People on the waitlist, e.g. "11". "" when there is no waitlist. */
  waiting: string;
  /** e.g. "About 2 people a fortnight". */
  waitMoves: string;
}

/** Therapist layout: getting to the in-person practice. */
export interface TherapistTravel {
  metro: string;
  bus: string;
  bike: string;
  entrance: string;
}

/** Therapist layout: a person or service the therapist works alongside.
 *  `kind` is one of psychiatrist | group | community | clinic | therapist. */
export interface TherapistWorksAlongside {
  kind: string;
  name: string;
  note: string;
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
  /** Practice skin: how the therapist works, one prose paragraph per entry. */
  approach?: string[] | null;
  /** Practice skin: training / qualifications, most recent first. */
  training?: string[] | null;
  /** Practice skin: where they practise. `lines` = address lines.
   *  (Room/building accessibility lives in the existing `access` key.) */
  venue?: { name: string; lines: string[] } | null;
  /** Practice skin: a 4-week availability grid. `startDate` is the ISO date of
   *  the first cell (a Monday); `cells` is 28 tri-state slots in row-major order
   *  (4 weeks × 7 days). Day numbers + month labels derive from `startDate`. */
  availability?: {
    startDate: string;
    slotTime: string;
    cells: PracticeAvailState[];
  } | null;
  /** Practice skin (therapist): fee breakdown rows shown in the sidebar.
   *  Named `feeSchedule` (not `fees`) — `fees` is the Classroom skin's key. */
  feeSchedule?: { label: string; value: string }[] | null;
  /** Chart skin (astrologer): the live sky band shown in the hero. */
  sky?: { moon: string; phase: string; note: string } | null;
  /** Chart skin: what the astrologer needs from a querent before a reading. */
  birthData?: {
    date: string;
    time: string;
    place: string;
    note: string;
  } | null;
  /** Chart skin: the "what a reading is not" boundary list. */
  ethics?: string[] | null;
  /** Chair skin: the price/booking band shown after the bio. */
  chair?: {
    rate: string;
    walkins: string;
    where: string;
    quiet: string;
  } | null;
  /** Chair skin: the "before you sit down" list at the foot. */
  beforeYouSit?: string[] | null;
  /** Runway skin: the credits dl at the foot (press / stockists / made / direct). */
  credits?: {
    press: string;
    stockists: string;
    made: string;
    contact: string;
  } | null;
  /** Gallery skin: the "now on view" band in the hero. */
  onView?: {
    title: string;
    artist: string;
    dates: string;
    room: string;
  } | null;
  /** Gallery skin: the "visiting" dl at the foot (hours / address / access / admission). */
  visit?: {
    hours: string;
    address: string;
    access: string;
    admission: string;
  } | null;
  /** Record (history) skin: "the record itself" dl + a gaps note at the foot. */
  record?: {
    held: string;
    access: string;
    consent: string;
    gaps: string;
  } | null;
  /** Poster (collective) skin: the "next" action band in the hero. */
  nextAction?: { what: string; when: string; where: string } | null;
  /** Poster (collective) skin: the "how we work" ordered principles list at the foot. */
  principles?: string[] | null;
  /** Classroom skin: the fees dl after the bio (cost / materials / where / extras + note). */
  fees?: {
    cost: string;
    materials: string;
    where: string;
    extras: string;
    note?: string | null;
  } | null;
  /** Classroom skin: the "what you leave with" promises list at the foot. */
  promises?: string[] | null;
  /** Therapist layout: the core facts (status, title, quote, contact). */
  therapist?: TherapistFacts | null;
  /** Therapist layout: lived-experience chips, in the therapist's words. */
  lived?: string[] | null;
  /** Therapist layout: "also speaks the language of" context chips. */
  contexts?: string[] | null;
  /** Therapist layout: approach chips (Person-centred, ACT, EMDR ...). */
  modalities?: string[] | null;
  /** Therapist layout: working-style chips as written ("Leans open"). */
  workingStyle?: string[] | null;
  /** Therapist layout: the "probably not for you if" list. */
  notFor?: string[] | null;
  /** Therapist layout: things the therapist does not do, as chips. */
  boundaries?: string[] | null;
  /** Therapist layout: who the practice serves ("Adults 18+", "Couples"). */
  whoFor?: string[] | null;
  /** Therapist layout: fees, sliding scale and the small print. */
  therapyFees?: TherapyFees | null;
  /** Therapist layout: insurer and euros back per session ("25"). */
  reimbursement?: { label: string; value: string }[] | null;
  /** Therapist layout: time to a first session and the waitlist size. */
  availabilitySummary?: TherapistAvailabilitySummary | null;
  /** Therapist layout: weekly hours rows ("Weekdays" / "17:00–21:00"). */
  hours?: { label: string; value: string }[] | null;
  /** Therapist layout: owner-typed open slots ("Tue 30 Sep · 18:00"). */
  openSlots?: string[] | null;
  /** Therapist layout: getting there (metro / bus / bike / entrance). */
  travel?: TherapistTravel | null;
  /** Therapist layout: accessibility items NOT offered (shown with an x).
   *  The offered ones live in the existing `access` key. */
  accessMissing?: string[] | null;
  /** Therapist layout: frequently asked questions. */
  faq?: { question: string; answer: string }[] | null;
  /** Therapist layout: people and services the therapist works alongside. */
  worksAlongside?: TherapistWorksAlongside[] | null;
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
