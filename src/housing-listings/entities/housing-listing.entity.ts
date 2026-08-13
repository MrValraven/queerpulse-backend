import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Moderation lifecycle for a member-submitted housing listing. Mirrors the
 * `listings` domain's `ListingStatus`: members never self-transition (only a
 * moderator/admin moves a listing out of `Review`); `create()` forces `Review`.
 */
export enum HousingListingStatus {
  Review = 'review',
  Question = 'question',
  Live = 'live',
}

/** The kind of housing offered. Mirrors the frontend's housing filter chips
 * (`queerpulse/src/features/economy/housing.data.ts#FILTERS`). */
export enum HousingListingType {
  Sublet = 'sublet',
  Room = 'room',
  Short = 'short',
  Studio = 'studio',
}

/**
 * Who is offering the home (Wave B1 transparency P2.6). `member` is a community
 * member listing their own place; `agent` is a broker/agency. Agents are NOT
 * banned — the disclosure just gets a visible badge on the listing so the
 * community norm ("brokers welcome, but labelled") is honoured. Defaults to
 * `member`.
 */
export enum HousingListerKind {
  Member = 'member',
  Agent = 'agent',
}

/**
 * Postgres `numeric` arrives over the wire as a string (to preserve arbitrary
 * precision). Coerce it to a JS number (or null) at the ORM boundary so the
 * response mapper and geo helpers never juggle string/number. Latitude and
 * longitude sit comfortably within double precision, so no data is lost.
 */
const numericToNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/**
 * A member-submitted rental/room housing listing. `ref` (`QPH-<year>-<seq>`)
 * is the human-readable identifier for owner mutations; `slug` is the public
 * browse lookup key. Kept entirely separate from the co-ops `housing/` module.
 */
@Entity('housing_listings')
export class HousingListing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_housing_listings_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref!: string;

  @Index('UQ_housing_listings_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Index('IDX_housing_listings_owner_id')
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Index('IDX_housing_listings_status')
  @Column({
    type: 'enum',
    enum: HousingListingStatus,
    enumName: 'housing_listings_status_enum',
    default: HousingListingStatus.Review,
  })
  status!: HousingListingStatus;

  @Column({
    type: 'enum',
    enum: HousingListingType,
    enumName: 'housing_listings_type_enum',
  })
  type!: HousingListingType;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  blurb!: string;

  @Column({ type: 'varchar', length: 120 })
  city!: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  area!: string;

  // ── Precise geolocation (ADDRESS PRIVACY) ──────────────────────────────────
  // The home's exact point. These are NEVER exposed on public browse or to a
  // stranger — only to the owner or an accepted (mutually-connected) enquirer.
  // Pre-connection the client receives an APPROXIMATE neighbourhood-centroid pin
  // derived from `area`/`city` instead (see housing-listing-response.ts +
  // housing-geo.ts). Nullable + additive so the migration is safe on old rows;
  // a production geocoder populates them on write (today they stay null unless
  // set out-of-band).
  @Column({
    type: 'numeric',
    precision: 9,
    scale: 6,
    nullable: true,
    transformer: numericToNumber,
  })
  latitude!: number | null;

  @Column({
    type: 'numeric',
    precision: 9,
    scale: 6,
    nullable: true,
    transformer: numericToNumber,
  })
  longitude!: number | null;

  // The full street address — the most sensitive location field. Same gate as
  // the precise coordinates above: owner or accepted enquirer only.
  @Column({ type: 'varchar', length: 200, nullable: true })
  addressLine!: string | null;

  @Column({ type: 'int' })
  rentEuros!: number;

  // Bedroom count (0 = studio). Nullable + additive so the migration is safe on
  // old rows; powers the "beds" browse filter. Indexed (hot filter column).
  @Index('IDX_housing_listings_bedrooms')
  @Column({ type: 'int', nullable: true })
  bedrooms!: number | null;

  @Column({ type: 'boolean', default: false })
  billsIncluded!: boolean;

  @Column({ type: 'boolean', default: false })
  lgbtqFriendly!: boolean;

  // ── Transparency + broker disclosure (Wave B1 P2.6) ────────────────────────
  // Required on create (`CreateHousingListingDto` enforces a non-empty value) so
  // every new listing carries an honest step-free/lift/access line. Kept
  // `default ''` at the column so the additive migration is safe on old rows.
  @Column({ type: 'varchar', length: 300, default: '' })
  accessibilityInfo!: string;

  // Member vs agent/broker disclosure — surfaced as a badge, never a bar.
  @Column({
    type: 'enum',
    enum: HousingListerKind,
    enumName: 'housing_listings_lister_kind_enum',
    default: HousingListerKind.Member,
  })
  listerKind!: HousingListerKind;

  // ── Pre-publish risk scoring (Wave B1 P0.6) ────────────────────────────────
  // Deterministic 0–100 red-flag score computed at create/update time (see
  // `housing-risk.ts`), plus the stable machine reason codes behind it. Drives
  // the risk-sorted moderation queue. NEVER exposed on public browse — only the
  // owner/moderator admin DTO carries it.
  @Index('IDX_housing_listings_risk_score')
  @Column({ type: 'int', default: 0 })
  riskScore!: number;

  @Column({ type: 'text', array: true, default: '{}' })
  riskReasons!: string[];

  @Column({ type: 'date', nullable: true })
  availableFrom!: string | null;

  @Column({ type: 'int', nullable: true })
  minStayMonths!: number | null;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  features!: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  idealFor!: string[];

  // Storage keys or external https:// URLs (validated with @IsImageReference on
  // input); resolved to URLs at the response boundary via toImageUrl.
  @Column({ type: 'text', array: true, default: '{}' })
  gallery!: string[];

  // Optional 360°/virtual-tour link (Matterport, a YouTube walkthrough, etc.)
  // — validated as an https URL on input. Rendered as an embedded/linked tour
  // section on the listing when present; null when the lister added none.
  @Column({ type: 'varchar', length: 500, nullable: true })
  virtualTourUrl!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
