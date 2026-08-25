import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Listing } from './listing.entity';

/**
 * A member's private enquiry to the business behind a directory listing,
 * delivered through the platform's own messaging rather than a `tel:` link, a
 * `mailto:` or an Instagram handle.
 *
 * WHY THIS EXISTS AT ALL, given the message itself lives in `messages`. It does
 * NOT store the enquiry's text and it must never start to: messaging owns
 * message storage, and duplicating a member's words into a second table would
 * mean an edit, a delete or a "delete for me" in the thread leaves a stale copy
 * behind on a listing. What this row stores is the LINK between a listing and a
 * conversation, which messaging has no reason to know about and the listing
 * has no other way to remember. Three things need it:
 *
 *  1. The enquirer, so `GET /directory/:slug/contact` can say "you already
 *     wrote to them" and deep-link straight to the existing thread instead of
 *     offering an empty compose box for the third time.
 *  2. The counted rate limits in `ListingEnquiriesService`, which the HTTP
 *     throttle cannot express: the shape that hurts a queer venue is not a
 *     burst inside one 60-second window, it is a steady trickle from one
 *     account over days (the same reasoning `listing_public_questions`
 *     documents for its own caps).
 *  3. An honest record that contact happened at all, which is what makes an
 *     abuse report about an enquiry investigable.
 *
 * COLUMNS.
 *  - `sender_id` carries a real FK with `ON DELETE CASCADE`. Unlike a review or
 *    a public question, this row is not content anybody else reads: it is one
 *    member's private outreach record, so an account erasure should take it
 *    with them rather than leave an orphan pointing at a conversation that has
 *    also gone.
 *  - `owner_id` is a SNAPSHOT of who the listing belonged to at the moment the
 *    enquiry was sent, and deliberately carries no FK, mirroring
 *    `ListingClaim.listingId`'s no-FK convention. Listings change hands
 *    (`ListingClaimsService.review`), and the point of this column is to record
 *    who actually received the message, which is not necessarily who owns the
 *    listing today.
 *  - `conversation_id` likewise carries no FK: it points across a domain
 *    boundary into messaging, and this module must not be able to cascade
 *    anything into a conversation. Conversations are never hard-deleted (a
 *    member "deleting" one only stamps their own `cleared_at`), so the
 *    reference stays resolvable.
 *
 * `listing_id` DOES carry an `ON DELETE CASCADE` FK, following
 * `listing_reviews.listing_id`: with the listing gone there is no surface left
 * for this row to answer a question on.
 */
@Entity('listing_enquiries')
// Backs both the "have I already written to this business?" read and the
// per-listing counted cap, which are the same lookup. Leads with `listing_id`
// so it also serves a listing-scoped scan on its own.
@Index('IDX_listing_enquiries_listing_id_sender_id', ['listingId', 'senderId'])
// Backs the across-all-listings daily cap and the erasure sweep.
@Index('IDX_listing_enquiries_sender_id_created_at', ['senderId', 'createdAt'])
export class ListingEnquiry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  listingId!: string;

  // Both FK'd columns keep their relation alongside the scalar so entity
  // metadata and the migration-owned schema agree and `migration:generate`
  // will not propose dropping the constraints (`ListingClaim`'s precedent).
  // `ownerId` and `conversationId` below deliberately have NEITHER a relation
  // nor an FK — see the class docstring.
  @ManyToOne(() => Listing, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'listing_id' })
  listing!: Listing;

  @Column({ type: 'uuid' })
  senderId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_id' })
  sender!: User;

  /** Who the listing belonged to when this was sent. A snapshot, not a live
   *  pointer at the current owner. */
  @Column({ type: 'uuid' })
  ownerId!: string;

  /** The 1:1 conversation the enquiry was delivered into, so the enquirer can
   *  be sent back to the thread they already started. */
  @Column({ type: 'uuid' })
  conversationId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
