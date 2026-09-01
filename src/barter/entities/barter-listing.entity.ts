import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The board's category facet. Mirrors the frontend's `CATS` chips
 * (`features/economy/barter.data.ts`) one-for-one so the existing filter row
 * maps straight onto a query parameter with no translation table.
 */
export enum BarterCategory {
  Creative = 'creative',
  Tech = 'tech',
  Legal = 'legal',
  Care = 'care',
  Food = 'food',
  Body = 'body',
}

/**
 * Which side of a swap the listing is about. `Both` means the member is
 * offering a skill AND naming what they want back, which is the common case —
 * the mode tabs treat it as matching both filters (see
 * `BarterService.applyModeFilter`).
 */
export enum BarterMode {
  Offering = 'offering',
  Seeking = 'seeking',
  Both = 'both',
}

/** Lifecycle. A closed listing stays readable but takes no new proposals. */
export enum BarterListingStatus {
  Open = 'open',
  Closed = 'closed',
}

/**
 * One post on the skill exchange: what a member can do, what they want back,
 * or both. Deliberately id-addressed rather than slugged — the frontend board
 * already links to `/barter/:id` and a swap post has no shareable public URL
 * the way a job or a gathering does.
 *
 * `offer`/`want` (and their `*_detail` long forms) are stored as NOT NULL with
 * an empty-string default rather than nullable: a `seeking`-only listing has no
 * offer, and the UI renders `b.offer && (...)`, so `''` is the shape it already
 * expects. Every read hand-maps to {@link BarterListingDTO}; the entity is
 * never returned raw.
 */
@Entity('barter_listings')
@Index('IDX_barter_listings_status_created_at', ['status', 'createdAt'])
export class BarterListing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_barter_listings_owner_id')
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Index('IDX_barter_listings_category')
  @Column({ type: 'enum', enum: BarterCategory })
  category!: BarterCategory;

  @Index('IDX_barter_listings_mode')
  @Column({ type: 'enum', enum: BarterMode })
  mode!: BarterMode;

  /** Headline of what the member gives. Empty for a pure `seeking` post. */
  @Column({ type: 'varchar', length: 160, default: '' })
  offer!: string;

  /** Headline of what the member wants. Empty for a pure `offering` post. */
  @Column({ type: 'varchar', length: 160, default: '' })
  want!: string;

  @Column({ type: 'text', default: '' })
  offerDetail!: string;

  @Column({ type: 'text', default: '' })
  wantDetail!: string;

  /** Free-text labels shown as chips. Bounded by the DTO (see
   * `CreateBarterListingDto`), stored as a Postgres text array like
   * `volunteer_opportunities.skills`. */
  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @Column({
    type: 'enum',
    enum: BarterListingStatus,
    default: BarterListingStatus.Open,
  })
  status!: BarterListingStatus;

  /**
   * When the poster last changed something a proposal was actually made
   * AGAINST: the category, the mode, or either headline (see
   * `BarterService.MATERIAL_EDIT_FIELDS`). Null until that happens.
   *
   * It exists because a listing edited out from under a pending proposal is a
   * trap: someone offered to trade for what the post said last week, and the
   * post now says something else. Rather than refuse the edit (which would
   * strand a poster behind their own typo) or silently rewrite the deal, the
   * stamp lets the proposer's own view say "this listing changed after you
   * proposed" and lets them withdraw the offer in the DM thread the proposal
   * opened.
   *
   * Deliberately NOT `updatedAt`: that moves on every save, including a close
   * and a purely cosmetic detail/tag edit, so reading it as "the deal changed"
   * would cry wolf on almost every write.
   */
  @Column({ type: 'timestamptz', nullable: true })
  materialEditedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
