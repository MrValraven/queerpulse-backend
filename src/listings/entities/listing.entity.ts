import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Moderation lifecycle for a member-submitted business directory listing.
 * Mirrors the frontend's `ListingStatus` union
 * (`queerpulse/src/features/marketing/listBusiness/listBusiness.data.ts`).
 * Members never self-transition their own listing (see
 * `ListingsController.setStatus`'s `RolesGuard` gate) — only a
 * moderator/admin moves it out of `Review`.
 */
export enum ListingStatus {
  Review = 'review',
  Question = 'question',
  Live = 'live',
}

/** Safe-space badge lifecycle on a business listing. `none` = not a safe space. */
export enum SafeSpaceStatus {
  None = 'none',
  Verified = 'verified',
  Removed = 'removed',
}

/** One "what you can rely on" promise shown on the safe-space detail page. */
export interface SafeSpacePromise {
  title: string;
  desc: string;
}

/** A member vouch for a safe space. `initials`/`tint` are derived server-side. */
export interface SafeSpaceVouch {
  name: string;
  byline: string;
  text: string;
  when: string;
}

/** Removal narrative, populated only when `safeSpaceStatus = removed`. */
export interface SafeSpaceRemoval {
  reason: string;
  removedDate: string;
  listedSince: string;
  flags: number;
  reasonLong: string[];
  timeline: { date: string; event: string }[];
  whatNow: string;
}

/** A single "what it actually is" bullet — mirrors the frontend's `WitLine`. */
export interface ListingWitLine {
  id: string;
  text: string;
}

/** One weekday's opening hours — mirrors the frontend's `DayHours`, keyed by
 * the frontend's `DAYS` id (e.g. `mon`, `tue`, ...) in the `hours` column. */
export interface ListingDayHours {
  open: boolean;
  from: string;
  to: string;
}

/** Mirrors the frontend's `ListingDraft["social"]`. */
export interface ListingSocial {
  instagram: string;
  website: string;
  email: string;
  phone: string;
}

/** Mirrors the frontend's `Record<PhotoKey, string>` (`photos`/`alt`
 * columns) — fixed to the frontend's four `PhotoKey` slots. */
export interface ListingPhotoSet {
  wide: string;
  d1: string;
  d2: string;
  vibe: string;
}

/**
 * A member-submitted business directory listing (spec §3 Tier 4
 * "listings"). The full wizard draft
 * (`queerpulse/.../listBusiness.data.ts#ListingDraft`) is persisted flat —
 * one column per draft field — plus the server-assigned identity/moderation
 * fields (`ref`, `slug`, `status`, `ownerId`) the review flow renders.
 *
 * `ref` (e.g. `QPL-2026-0007`) is the human-readable business reference the
 * frontend addresses in every mutation path (`GET/PATCH/DELETE /listings/:ref`
 * — see `listings.api.ts`); `slug` is a separate, purely cosmetic
 * `slugify(name)`-derived value carried through on the DTO but never used as
 * a lookup key by the frontend.
 */
@Entity('listings')
export class Listing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_listings_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref: string;

  @Index('UQ_listings_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Index('IDX_listings_owner_id')
  @Column({ type: 'uuid' })
  ownerId: string;

  @Column({
    type: 'enum',
    enum: ListingStatus,
    enumName: 'listings_status_enum',
    default: ListingStatus.Review,
  })
  status: ListingStatus;

  // --- ListingDraft fields (flat, one column each) ---

  @Column({ type: 'varchar', default: '' })
  path: string;

  @Column({ type: 'varchar', default: '' })
  verify: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', array: true, default: '{}' })
  cats: string[];

  @Column({ type: 'varchar', default: '' })
  hood: string;

  @Column({ type: 'varchar', default: '' })
  badge: string;

  @Column({ type: 'text', default: '' })
  evidence: string;

  @Column({ type: 'varchar', default: '' })
  price: string;

  @Column({ type: 'varchar', length: 140, default: '' })
  blurb: string;

  @Column({ type: 'varchar', default: '' })
  tagline: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  whatItIs: ListingWitLine[];

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  goodFor: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  langs: string[];

  @Column({ type: 'text', default: '' })
  address: string;

  @Column({ type: 'boolean', default: false })
  geocoded: boolean;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  hours: Record<string, ListingDayHours>;

  @Column({ type: 'text', default: '' })
  hoursNote: string;

  // Always populated by the service (`ListingsService`'s `normalizeSocial`)
  // so every subfield is present (never omitted), mirroring
  // `PartnersService.normalizeContact`'s precedent.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  social: ListingSocial;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  photos: ListingPhotoSet;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  alt: ListingPhotoSet;

  @Column({ type: 'varchar', default: '' })
  rel: string;

  @Column({ type: 'varchar', default: '' })
  ownerName: string;

  @Column({ type: 'varchar', default: '' })
  ownerRole: string;

  @Column({ type: 'text', default: '' })
  ownerBio: string;

  @Column({ type: 'varchar', default: '' })
  visibility: string;

  @Column({ type: 'boolean', default: false })
  linkToProfile: boolean;

  @Column({ type: 'varchar', default: '' })
  contactEmail: string;

  @Column({ type: 'text', array: true, default: '{}' })
  notify: string[];

  @Column({ type: 'boolean', default: false })
  consentOuting: boolean;

  @Column({ type: 'boolean', default: false })
  consentGuide: boolean;

  // --- Partner-space fields (host directory) ---
  // A listing flagged as a QueerPulse partner venue surfaces on the public
  // host page's "Partner spaces" card (`GET /directory/spaces`). These are an
  // ops/moderation decision, not part of the member-submission wizard, so they
  // default to unpartnered/empty and are set by seed or a future admin toggle.

  @Index('IDX_listings_is_partnered_with_queerpulse')
  @Column({ type: 'boolean', default: false })
  isPartneredWithQueerpulse: boolean;

  /** Human venue type shown on the host card, e.g. "Warehouse". */
  @Column({ type: 'varchar', default: '' })
  spaceType: string;

  /** Max guests the venue hosts ("up to N"); null when not specified. */
  @Column({ type: 'int', nullable: true })
  capacity: number | null;

  /** Trailing qualifier on the host card, e.g. "events only". */
  @Column({ type: 'varchar', default: '' })
  hostNote: string;

  // --- Safe-space fields (safety directory) ---
  // A listing a moderator has vetted as a safe space surfaces on the public
  // Safe Spaces page (`GET /directory/safe-spaces`). `none` by default; set by
  // the moderator toggle (`PATCH /listings/:ref/safe-space`) or seed.

  @Index('IDX_listings_safe_space_status')
  @Column({
    type: 'enum',
    enum: SafeSpaceStatus,
    enumName: 'listings_safe_space_status_enum',
    default: SafeSpaceStatus.None,
  })
  safeSpaceStatus: SafeSpaceStatus;

  @Column({ type: 'int', nullable: true })
  safeSpaceTier: number | null;

  @Column({ type: 'varchar', default: '' })
  safeSpaceVerifier: string;

  @Column({ type: 'date', nullable: true })
  safeSpaceReVerifiedAt: string | null;

  @Column({ type: 'text', default: '' })
  safeSpaceSub: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  safeSpacePromises: SafeSpacePromise[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  safeSpaceVouches: SafeSpaceVouch[];

  @Column({ type: 'jsonb', nullable: true })
  safeSpaceRemoval: SafeSpaceRemoval | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
