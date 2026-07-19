import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Closed set (the frontend's `MODES` in `AddWorkshopModal.tsx`), so it gets a
 * DB enum — mirroring `Job.format`'s `job_format_enum`. `cat` below stays a
 * plain `varchar` for the same reason `Job.category` does: the category set is
 * open-ended and only validated at the DTO boundary.
 */
export enum WorkshopMode {
  InPerson = 'in_person',
  Online = 'online',
  Hybrid = 'hybrid',
}

/** Mirrors the frontend's `ImageSlotTint` union — also a closed set. */
export enum WorkshopHeroTint {
  Default = 'default',
  Coral = 'coral',
  Jade = 'jade',
  Plum = 'plum',
}

/** One evening/afternoon of a workshop (frontend `WorkshopSession`). */
export interface WorkshopSession {
  /** Session number as displayed, e.g. "01" — the UI renders its last digit
   *  in coral italic, so the zero-padding is content, not formatting. */
  n: string;
  title: string;
  desc: string;
  date: string;
  length: string;
  /** Already happened — dimmed in the table. */
  done: boolean;
}

/** A "what's included / what to bring" line (frontend `WorkshopNeed`). */
export interface WorkshopNeed {
  label: string;
  detail: string;
  included: boolean;
  tag: string | null;
}

/**
 * A rung on the sliding scale (frontend `WorkshopTier`). The frontend's
 * `amount` is a pre-formatted string ("€180"); we store the **number** and let
 * the client format it with its own `Formatters.currency`, consistent with
 * `Job.rateMin`/`rateMax` being `numeric` rather than the display-only
 * `Job.salary` string.
 */
export interface WorkshopTier {
  label: string;
  amount: number;
  sliding: boolean;
}

/** Frontend `Workshop["location"]`. */
export interface WorkshopLocation {
  name: string;
  address: string;
  access: string;
}

/**
 * Postgres `numeric` round-trips as a string through `pg` — same transformer
 * (and same rationale) as `Job`'s `numericTransformer`, kept file-local rather
 * than shared to match that precedent.
 */
const numericTransformer = {
  to: (value: number | null | undefined): number => value ?? 0,
  from: (value: string | null): number => (value === null ? 0 : Number(value)),
};

@Entity('workshops')
export class Workshop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_workshops_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Index('IDX_workshops_host_id')
  @Column({ type: 'uuid' })
  hostId: string;

  // Free-text descriptor of the host's standing for *this* workshop ("Editora
  // Anjos · 9 years printing"). Not part of `MemberRef` — that is the shared,
  // cross-domain member identity; this is workshop-owned copy.
  @Column({ type: 'varchar', nullable: true })
  hostRole: string | null;

  @Column({ type: 'varchar' })
  cat: string;

  @Column({ type: 'varchar' })
  title: string;

  // Second half of the headline, rendered in coral italic. Empty for
  // member-added workshops (`buildWorkshop` sets `titleEm: ""`).
  @Column({ type: 'varchar', default: '' })
  titleEm: string;

  @Column({
    type: 'enum',
    enum: WorkshopMode,
    enumName: 'workshop_mode_enum',
  })
  mode: WorkshopMode;

  // The numeric truth behind the frontend's derived `format` string
  // ("Workshop · 6 weeks · group of 8"). That string is i18n chrome composed
  // client-side (see `addWorkshop.build.ts`'s header comment), so the API
  // ships the inputs, not the sentence.
  @Column({ type: 'integer' })
  weeks: number;

  // The cap. `spotsFilled` is deliberately NOT a column beside it: it is
  // derived with a COUNT over `workshop_rsvps` rows with status 'going' (see
  // `WorkshopRsvpsService.spotsFilledFor`). It used to be a stored integer that
  // nothing incremented; `AddWorkshopRsvps` (1782800780000) drops it rather
  // than leave a denormalized counter to drift away from the bookings it
  // counts. Same treatment `volunteering` gives its own `spotsFilled`.
  @Column({ type: 'integer' })
  spotsTotal: number;

  @Column({ type: 'text' })
  blurb: string;

  // "What you'll actually do" — one paragraph per entry.
  @Column({ type: 'text', array: true, default: '{}' })
  about: string[];

  @Column({ type: 'varchar', nullable: true })
  heroPlaceholder: string | null;

  @Column({
    type: 'enum',
    enum: WorkshopHeroTint,
    enumName: 'workshop_hero_tint_enum',
    default: WorkshopHeroTint.Default,
  })
  heroTint: WorkshopHeroTint;

  // Headline price. The frontend's `price` is the formatted "€180"; the
  // structured value lives here (0 = free) with `currency` alongside, matching
  // how `jobs` separates `salary` (display) from `rateMin`/`rateMax` +
  // `currency` (structured). No formatted string is stored.
  @Column({ type: 'numeric', default: 0, transformer: numericTransformer })
  price: number;

  @Column({ type: 'varchar', default: 'EUR' })
  currency: string;

  // The three below are nullable because `buildWorkshop` fills them with i18n
  // placeholders ("date TBA", "six weeks · solidarity rate available") that the
  // client composes itself. NULL means "the host gave us nothing — render your
  // own default"; a value is the host's own words and passes through.
  @Column({ type: 'varchar', nullable: true })
  priceSub: string | null;

  @Column({ type: 'varchar', nullable: true })
  startDate: string | null;

  @Column({ type: 'varchar', nullable: true })
  cancellation: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tiers: WorkshopTier[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  sessions: WorkshopSession[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  needs: WorkshopNeed[];

  @Column({ type: 'text', array: true, default: '{}' })
  pastWork: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  // Always fully populated by the service — see `normalizeLocation`.
  @Column({ type: 'jsonb' })
  location: WorkshopLocation;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
