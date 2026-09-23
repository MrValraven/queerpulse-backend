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
import { Listing } from './listing.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Where an offer stands. An offer is extended by staff and resolved by the
 * member it names, so the two terminal states a member can reach (accepted,
 * declined) sit alongside the one staff can reach (revoked).
 */
export enum ListingOwnerOfferStatus {
  Offered = 'offered',
  Accepted = 'accepted',
  Declined = 'declined',
  Revoked = 'revoked',
}

/** The statuses that still occupy the single open-offer slot on a listing. */
export const LIVE_LISTING_OWNER_OFFER_STATUSES = [
  ListingOwnerOfferStatus.Offered,
] as const;

/**
 * An admin nominating a member as the owner of a listing that currently has
 * none.
 *
 * Ownership is never written straight into `listings.owner_id` by this table.
 * The row sits at `offered` until the member answers, and only an accept
 * calls the shared ownership transfer. Nobody's name reaches a public
 * listing without them agreeing to it.
 *
 * A listing has at most one open offer, enforced by the partial unique index
 * below. Re-offering to somebody else means revoking the first offer, which
 * is correct: two people cannot both be told they are being given the same
 * business.
 */
@Entity('listing_owner_offers')
@Index('UQ_listing_owner_offers_open', ['listingId'], {
  unique: true,
  where: `"status" = 'offered'`,
})
@Index('IDX_listing_owner_offers_offeree_id_status', ['offereeId', 'status'])
export class ListingOwnerOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  listingId!: string;

  @ManyToOne(() => Listing, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'listing_id' })
  listing?: Listing;

  /** The member being offered the listing. */
  @Column({ type: 'uuid' })
  offereeId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'offeree_id' })
  offeree?: User;

  /**
   * The admin who extended the offer. Nullable because an erased staff
   * account must not take the offer history with it.
   */
  @Column({ type: 'uuid', nullable: true })
  offeredByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'offered_by_user_id' })
  offeredBy?: User | null;

  /**
   * The admin's message to the member. The co-manager invite deliberately
   * carries no note because it arrives from somebody you already know. An
   * unsolicited offer from staff needs the context.
   */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({
    type: 'enum',
    enum: ListingOwnerOfferStatus,
    enumName: 'listing_owner_offers_status_enum',
    default: ListingOwnerOfferStatus.Offered,
  })
  status!: ListingOwnerOfferStatus;

  @Column({ type: 'timestamptz' })
  offeredAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
