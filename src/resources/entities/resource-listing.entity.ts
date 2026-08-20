import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Category shared by `ResourceListing` and `ResourceSuggestion` (the same
 * Postgres enum type, `resource_listing_category_enum`, backs both columns —
 * see the migration). Mirrors the two resource-guide categories CNT-14
 * flagged as having no real directory behind them. Deliberately a closed enum
 * (not a free-form varchar like `Resource.category`) — a new category is a
 * curation decision that goes through a migration, not something app code
 * adds on its own.
 */
export enum ResourceListingCategory {
  LegalAid = 'legal_aid',
  SexualHealthTesting = 'sexual_health_testing',
}

/** `active` listings are the only ones the public directory endpoint returns;
 *  `archived` keeps the row (and its history) without deleting it outright. */
export enum ResourceListingStatus {
  Active = 'active',
  Archived = 'archived',
}

/**
 * An admin-vetted, real-world organisation (a law clinic, a testing site) an
 * active member can contact for Legal Aid / Sexual Health Testing help.
 * Deliberately lighter than the business `Listing` entity — no wizard steps,
 * no photos, no owner-claim flow — this is curated reference content entered
 * by staff, never a member-owned profile. See the design doc's "Why not the
 * therapist-directory pattern" note: Mental Health's genuinely-backed
 * category is real member subprofiles, which doesn't fit organisations that
 * aren't QueerPulse members.
 */
@Entity('resource_listing')
export class ResourceListing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_resource_listing_category')
  @Column({
    type: 'enum',
    enum: ResourceListingCategory,
    enumName: 'resource_listing_category_enum',
  })
  category!: ResourceListingCategory;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  // Contact: at least one of phone/email/website is required — enforced at
  // the DTO level on create (`HasAtLeastOneContactField`) and re-checked
  // against the merged row in `AdminResourceListingsService.update`, since a
  // PATCH can legally omit fields it isn't changing.
  @Column({ type: 'varchar', length: 40, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  website!: string | null;

  // Free-text region/address — nullable, since some resources are
  // phone/web-only.
  @Column({ type: 'varchar', length: 200, nullable: true })
  region!: string | null;

  @Column({
    type: 'enum',
    enum: ResourceListingStatus,
    enumName: 'resource_listing_status_enum',
    default: ResourceListingStatus.Active,
  })
  status!: ResourceListingStatus;

  // The staff member who entered / last edited this row. No FK constraint —
  // mirrors `ReadingGroupProposal.decidedBy`: this is an audit trail that
  // must outlive a staff account's deletion, not a live relationship.
  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'uuid' })
  updatedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
