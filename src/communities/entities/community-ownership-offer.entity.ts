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
import { Community } from './community.entity';

/**
 * Where an ownership offer stands. The owner extends it and may cancel it;
 * the member it names accepts or declines it; time closes it at `expiresAt`.
 */
export enum CommunityOwnershipOfferStatus {
  Offered = 'offered',
  Accepted = 'accepted',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Expired = 'expired',
}

/**
 * How long an ownership offer stays open before it lapses on its own: 14
 * days. Long enough for a member who checks in weekly to see it twice, short
 * enough that a stale offer cannot be accepted months later by someone the
 * owner has since fallen out with.
 */
export const COMMUNITY_OWNERSHIP_OFFER_TTL_DAYS = 14;

/**
 * PRD-514. An owner offering their community to another member of its
 * roster.
 *
 * Ownership is never written by the offer itself. The row sits at `offered`
 * until the member answers, and only their accept moves
 * `communities.owner_id`. Nobody becomes the face of a community without
 * agreeing to it. Shaped like `ListingOwnerOffer`, the listings equivalent.
 *
 * A community has at most one open offer, enforced by the partial unique
 * index below. Offering to somebody else means cancelling the first offer.
 *
 * `fromOwnerId` is the owner of record when the offer was made. An accept is
 * refused once `communities.owner_id` no longer matches it, so an offer made
 * by an owner who has since lost the community (to a parent cascade, an
 * admin reassignment or an erasure) cannot move it.
 */
@Entity('community_ownership_offers')
@Index('UQ_community_ownership_offers_open', ['communityId'], {
  unique: true,
  where: `"status" = 'offered'`,
})
@Index('IDX_community_ownership_offers_offeree_id_status', [
  'offereeId',
  'status',
])
export class CommunityOwnershipOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'community_id' })
  community?: Community;

  /** The member being offered the community. */
  @Column({ type: 'uuid' })
  offereeId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'offeree_id' })
  offeree?: User;

  /**
   * Who extended the offer: the owner, or on a space the parent's owner.
   * Nullable so an erased account does not take the offer history with it.
   */
  @Column({ type: 'uuid', nullable: true })
  offeredByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'offered_by_user_id' })
  offeredBy?: User | null;

  /** The owner of record when the offer was made. See the class comment. */
  @Column({ type: 'uuid', nullable: true })
  fromOwnerId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'from_owner_id' })
  fromOwner?: User | null;

  @Column({
    type: 'enum',
    enum: CommunityOwnershipOfferStatus,
    enumName: 'community_ownership_offers_status_enum',
    default: CommunityOwnershipOfferStatus.Offered,
  })
  status!: CommunityOwnershipOfferStatus;

  @Column({ type: 'timestamptz' })
  offeredAt!: Date;

  /** `offeredAt` plus `COMMUNITY_OWNERSHIP_OFFER_TTL_DAYS`. */
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
