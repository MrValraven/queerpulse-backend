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
  /** Waiting on a human. Every create lands here, and so does every owner edit
   * that changes a field a moderator actually reviewed. */
  Review = 'review',
  /** Changes requested: a moderator sent it back to the lister with a reason.
   * The lister fixes it and their next content edit returns it to `Review`. */
  Question = 'question',
  /** Approved and publicly browsable. */
  Live = 'live',
  /**
   * Refused by a moderator, with a required reason. Never publicly browsable.
   * Not a grave: an owner edit that changes moderated content returns the
   * listing to `Review`, so a lister who fixes the problem can be re-reviewed.
   * Added by `AddHousingModerationDecisionEnums1794720100000`.
   */
  Rejected = 'rejected',
  /**
   * Was live, then pulled by a moderator, with a required reason. Distinct from
   * `Rejected` so the lister's notification and the console can tell "we never
   * published this" from "we removed something that was published" — different
   * facts, and only one of them was ever visible to the community.
   * Added by `AddHousingModerationDecisionEnums1794720100000`.
   */
  TakenDown = 'taken_down',
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
// Composite index backing both the sweep's WHERE (status = live AND filled_at
// IS NULL AND expires_at < now()) and the browse query's (status = live AND
// expires_at > now()) — TypeORM composite indexes are declared class-level,
// not on the property (see e.g. `roadmap-item.entity.ts`'s column/sortOrder).
@Entity('housing_listings')
@Index('IDX_housing_listings_status_expires_at', ['status', 'expiresAt'])
export class HousingListing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_housing_listings_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref!: string;

  @Index('UQ_housing_listings_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted the home listing plus every viewing and review attached to it. It is now `ON DELETE SET NULL`, so
  // NULL here means "the lister's account was erased" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_housing_listings_owner_id')
  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

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
  // housing-geo.ts). Nullable + additive so the migration is safe on old rows.
  //
  // Populated from `addressLine` by `HousingListingsService`, which hands the
  // address to `GeocodeService` AFTER the row is committed and never on the
  // request path: the geocoder is a rate-limited outbound call, so a listing
  // must be able to save with these still null. They stay null for a listing
  // with no address on file and for one whose address could not be placed, and
  // they are cleared the moment `addressLine` changes so a stale pin can never
  // point at a home the lister has moved out of.
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

  /**
   * Up-front deposit in EUROS, following `rentEuros` above: whole euros as an
   * `int`, the same unit a renter compares against the rent, so the board can
   * cap it without knowing a listing's rent. Months-of-rent was the tempting
   * alternative and is worse: it is only comparable once you also hold the
   * rent, and listers state deposits both ways ("one month", "€900") so the
   * unit that survives translation to a filter is the money.
   *
   * NULLABLE, and null means UNKNOWN. Every row that exists today has no
   * value, and an unstated deposit must never read as zero: the `depositMax`
   * browse filter EXCLUDES a null rather than showing it under the cap, both
   * in SQL and in the saved-search twin.
   */
  @Column({ type: 'int', nullable: true })
  depositEuros!: number | null;

  // Bedroom count (0 = studio). Nullable + additive so the migration is safe on
  // old rows; powers the "beds" browse filter. Indexed (hot filter column).
  @Index('IDX_housing_listings_bedrooms')
  @Column({ type: 'int', nullable: true })
  bedrooms!: number | null;

  @Column({ type: 'boolean', default: false })
  billsIncluded!: boolean;

  /**
   * Always `true` (BE-HSG-07). Posting a home requires the mandatory LGBTQ+
   * affirming pledge, so affirmation is a universal baseline, never a
   * per-listing opt-in. `HousingListingsService` hard-sets it on create and
   * `applyUpdate` no longer reads it; the default here matches so a row
   * inserted outside the service cannot reintroduce a `false`. Kept as a column
   * rather than dropped because the public DTO still emits it (dropping it is a
   * breaking wire change, and a follow-up for when no client reads it). See
   * migration `BackfillHousingListingAffirmingBaseline1793530400000`.
   */
  @Column({ type: 'boolean', default: true })
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

  // ── Moderation decision trail (LOC-01) ─────────────────────────────────────
  // The LAST decision a moderator recorded on this listing. The immutable
  // cross-listing trail lives in `mod_audit_logs` (one row per decision, written
  // by `HousingListingModerationService.decide`); these three columns are the
  // denormalised "what happened most recently", so the lister's own management
  // view and the review console can render it without a join.
  //
  // PRIVACY: `decisionReason` is moderator-authored prose ABOUT this listing.
  // It reaches the owner and moderators only — `toHousingListingDTO` attaches it
  // behind an explicit `includeDecision` flag that public browse never sets.
  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  // NULL once the deciding moderator erases their account (FK is
  // `ON DELETE SET NULL`), mirroring `mod_audit_logs.actor_id`: a decision
  // outlives the person who made it.
  @Column({ type: 'uuid', nullable: true })
  decidedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /**
   * When this listing was published for the FIRST time, or null while it never
   * has been (ENG-170).
   *
   * The at-most-once claim behind the saved-search go-live alert. `status` alone
   * cannot answer "has this ever been live": an owner PATCH to a moderated field
   * knocks a live listing back to `review`
   * (`HousingListingsService.moderatedHousingFingerprint`), so the moderator's
   * next approval sees a non-live listing again and, before this column, fanned
   * the same alert out to every matching saved search a second time. One typo
   * fix plus one approval was a second platform-wide broadcast, and nothing
   * downstream deduplicated it: the listener's `seen` set lives inside a single
   * event, and `HousingListingMatch` has no bundling subject.
   *
   * Claimed with a conditional UPDATE (`first_live_at IS NULL`), the same shape
   * `events.nearly_full_notified_at` and `membership_cards.expiry_warning_sent_at`
   * use, so two concurrent approvals cannot both alert.
   *
   * NEVER cleared. Unlike `nearly_full_notified_at` (a gathering that empties and
   * refills is genuinely nearly full again), "a home matching your search was
   * published" is true about a given listing exactly once. A take-down and a
   * re-approval months later is the same home the platform already announced, it
   * is reachable from browse and from the member's own saved search, and
   * re-alerting would turn a moderator's corrective action into a broadcast and
   * hand a lister a take-down/re-approve loop that reaches every matching inbox.
   */
  @Column({ type: 'timestamptz', nullable: true })
  firstLiveAt!: Date | null;

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

  // ── Owner lifecycle (HSG-1 / HSG-3) ────────────────────────────────────────
  // Orthogonal to `status` above: `status` is the MODERATION lifecycle (a
  // member never self-transitions it), while `filledAt` is a member-settable
  // "found a place / no longer looking" signal an owner can flip back and
  // forth via `PATCH :ref/mark-filled` / `PATCH :ref/mark-available`. Also set
  // by `HousingListingExpirySweeperService` (the daily cron) when a listing's
  // `expiresAt` passes unattended — same "hide from public browse" effect,
  // never a hard delete. Null = still looking / still live to the public.
  @Column({ type: 'timestamptz', nullable: true })
  filledAt!: Date | null;

  // Auto-computed at create time (see HousingListingsService.computeExpiry,
  // DEFAULT_LISTING_LIFETIME_DAYS) and resettable by the owner via
  // `PATCH :ref/extend`. NOT NULL (mirrors `board_posts.expires_at` —
  // AddBoardPostLifecycleFields1791200100000): every listing always carries a
  // real expiry, so browse/sweep queries never need an `IS NULL` branch. The
  // migration backfills existing rows with a fresh 60-day window from `now()`.
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  // PRD-244. When the pre-expiry warning was written for the CURRENT term of
  // this listing. Null means "not warned yet for this term".
  //
  // The reason the column exists: the warning sweep is the same DAILY cron
  // that soft-expires overdue listings, so without a marker every owner inside
  // the seven-day window would be told again every morning for a week. Claimed
  // with a conditional UPDATE whose WHERE still carries
  // `expiry_warning_sent_at IS NULL`, the shape
  // `membership_cards.expiry_warning_sent_at` and
  // `deletion_request.final_warning_sent_at` both use, so two ticks racing
  // cannot both send.
  //
  // Cleared back to null by every path that gives the listing a fresh term
  // (`extend`, `markAvailable` when it refreshes a stale expiry, and moderator
  // approval when it does the same), because the next term earns its own
  // warning. The marker means "warned for this term", never "warned once,
  // ever".
  @Column({ type: 'timestamptz', nullable: true })
  expiryWarningSentAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
