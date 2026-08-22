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
import { HousingGroup } from './housing-group.entity';

/**
 * Moderation lifecycle for a group listing. Mirrors `HousingListingStatus`
 * exactly (`housing-listings/entities/housing-listing.entity.ts`): members
 * never self-transition — `HousingGroupsService.createListing` forces `Review`
 * and only a housing moderator moves a listing to `Live`.
 *
 * `question` is deliberately carried over from the sibling enum so the two
 * housing surfaces share one moderation vocabulary ("we need to ask the poster
 * something before this goes public").
 */
export enum GroupListingStatus {
  Review = 'review',
  Question = 'question',
  Live = 'live',
}

/**
 * A housing listing shared inside a group. The group's norms are enforced as
 * product rules on this row: price transparency (`priceEuros`) and
 * accessibility information (`accessibilityInfo`) are NOT NULL and required by
 * the create DTO — a listing physically cannot exist without them.
 *
 * Two independent moderation controls sit on the row and are NOT
 * interchangeable (BE-HSG-01):
 *  - `status` is the PRE-publication gate. Every new listing lands in `review`
 *    and is invisible to the public until a moderator approves it, exactly as
 *    `housing_listings.status` works. This closed the side door where a group
 *    listing reached anonymous visitors (and a 30s CDN cache) with no review,
 *    no risk score and no verification step-up, while the sibling
 *    member-listing surface forced all three.
 *  - `hidden`/`hiddenReason` is the POST-publication takedown for a norm
 *    violation (hate speech, broker, opaque pricing) — a reversible hide that
 *    keeps an audit trail instead of hard-deleting.
 *
 * `riskScore`/`riskReasons` are the same deterministic `assessHousingRisk`
 * output the sibling stores: they never auto-publish or auto-refuse anything,
 * they sort the moderator's queue riskiest-first with machine reasons attached.
 */
@Entity('group_listings')
export class GroupListing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_group_listings_group_id')
  @Column({ type: 'uuid' })
  groupId!: string;

  @ManyToOne(() => HousingGroup, (group) => group.listings, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'group_id' })
  group!: HousingGroup;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'varchar' })
  neighbourhood!: string;

  /** Required price transparency (monthly rent in euros) — a group norm. */
  @Column({ type: 'int' })
  priceEuros!: number;

  /** Required accessibility information — a group norm (never nullable). */
  @Column({ type: 'text' })
  accessibilityInfo!: string;

  /**
   * Pre-publication moderation state. Defaults to `review`: a group listing is
   * NOT public until a housing moderator approves it. Indexed because the
   * public read (`listVisibleListings`) filters on it on every group page.
   */
  @Index('IDX_group_listings_status')
  @Column({
    type: 'enum',
    enum: GroupListingStatus,
    enumName: 'group_listings_status_enum',
    default: GroupListingStatus.Review,
  })
  status!: GroupListingStatus;

  /**
   * Deterministic 0–100 red-flag score from `assessHousingRisk`, computed at
   * create time from the submitted text + the poster's real verification level.
   * Moderator-facing only — it never reaches the public DTO.
   */
  @Column({ type: 'int', default: 0 })
  riskScore!: number;

  /** Stable machine reason codes behind `riskScore` (never localized here). */
  @Column({ type: 'text', array: true, default: '{}' })
  riskReasons!: string[];

  /** Hidden by a moderator for a norm violation (hate speech, broker, etc.). */
  @Column({ type: 'boolean', default: false })
  hidden!: boolean;

  @Column({ type: 'text', nullable: true })
  hiddenReason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
