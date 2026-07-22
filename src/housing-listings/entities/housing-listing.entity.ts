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
 * A member-submitted rental/room housing listing. `ref` (`QPH-<year>-<seq>`)
 * is the human-readable identifier for owner mutations; `slug` is the public
 * browse lookup key. Kept entirely separate from the co-ops `housing/` module.
 */
@Entity('housing_listings')
export class HousingListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_housing_listings_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref: string;

  @Index('UQ_housing_listings_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Index('IDX_housing_listings_owner_id')
  @Column({ type: 'uuid' })
  ownerId: string;

  @Index('IDX_housing_listings_status')
  @Column({
    type: 'enum',
    enum: HousingListingStatus,
    enumName: 'housing_listings_status_enum',
    default: HousingListingStatus.Review,
  })
  status: HousingListingStatus;

  @Column({
    type: 'enum',
    enum: HousingListingType,
    enumName: 'housing_listings_type_enum',
  })
  type: HousingListingType;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  blurb: string;

  @Column({ type: 'varchar', length: 120 })
  city: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  area: string;

  @Column({ type: 'int' })
  rentEuros: number;

  @Column({ type: 'boolean', default: false })
  billsIncluded: boolean;

  @Column({ type: 'boolean', default: false })
  lgbtqFriendly: boolean;

  @Column({ type: 'date', nullable: true })
  availableFrom: string | null;

  @Column({ type: 'int', nullable: true })
  minStayMonths: number | null;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'text', array: true, default: '{}' })
  features: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  idealFor: string[];

  // Storage keys or external https:// URLs (validated with @IsImageReference on
  // input); resolved to URLs at the response boundary via toImageUrl.
  @Column({ type: 'text', array: true, default: '{}' })
  gallery: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
