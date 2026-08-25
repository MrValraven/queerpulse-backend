import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Where one member sits on one listing's co-manager seat.
 *
 * `invited` and `active` are the two LIVE states: together they occupy a seat
 * and count toward `MAX_CO_MANAGERS_PER_LISTING`. The other three are terminal
 * records of how a seat ended, kept so a re-invite reuses the same row (see the
 * unique constraint on the class) and so the pair of moderation events in the
 * listing's history has something to agree with.
 */
export enum ListingCoManagerStatus {
  /** Invited by the owner, has not answered yet. Grants NO access. */
  Invited = 'invited',
  /** Accepted the invitation. This is the only status that grants access. */
  Active = 'active',
  /** The invited member said no. */
  Declined = 'declined',
  /** The owner took the seat back, or an approved ownership claim cleared it. */
  Revoked = 'revoked',
  /** The co-manager stepped down themselves. */
  Left = 'left',
}

/**
 * A co-manager seat on a business directory listing.
 *
 * WHY THIS TABLE EXISTS. `listings.owner_id` holds exactly one member, so a
 * venue run by two people had no way to share its page: the second person
 * either used the first person's login or had no access at all. This table adds
 * day-to-day management access without touching `owner_id`, which is the same
 * shape `community_members.role = 'co_owner'` took for communities. Stated
 * plainly because it is the whole design: there is still exactly ONE
 * accountable owner of record, a co-manager is never written into `owner_id`,
 * and becoming the owner is still an explicit ownership transfer.
 *
 * INVITED, NEVER DIRECT-ADDED. A row starts at `invited` and grants nothing
 * until the invited member flips it to `active` themselves. Handing someone
 * write access to a queer business's public page is not something a third party
 * gets to do to them, and it is not something they should discover afterwards.
 *
 * NOT PUBLIC. Nothing in this table appears in any public response. The
 * directory's public DTOs carry no co-manager field, and the roster read is
 * behind the same owner-or-co-manager gate as the rest of the management
 * surface. Publishing who works at a queer venue is a safety decision, and this
 * feature does not make it on anybody's behalf.
 *
 * COLUMNS AND THEIR FKs.
 *  - `listing_id` cascades from `listings`, following
 *    `listing_enquiries.listing_id`: an access grant to a listing that no longer
 *    exists is not a record worth keeping. This deliberately differs from
 *    `listing_moderation_events.listing_id`, which has no FK precisely so the
 *    audit of a deletion survives it. An audit row and an access row want
 *    opposite things here.
 *  - `user_id` cascades from `users`. The seat is the member; with the account
 *    erased there is no seat, and a `SET NULL` orphan would be a row granting
 *    access to nobody that still consumes one of the listing's five seats.
 *  - `invited_by_user_id` is `SET NULL`, mirroring
 *    `listing_moderation_events.actor_id`: who did it should stay referentially
 *    honest, and the seat outlives the erasure of the owner who created it
 *    (listings change hands).
 *
 * ONE ROW PER MEMBER PER LISTING is a database constraint, not a convention.
 * `UQ_listing_co_managers_listing_user` is a plain (non-partial) unique
 * constraint over `(listing_id, user_id)`, which is stronger than the partial
 * index `listing_reviews` uses for its one-review-per-member rule: there is no
 * predicate to get wrong, and a member who declined and was invited again
 * reuses their existing row rather than accumulating history nobody reads. The
 * history that IS read lives in `listing_moderation_events`
 * (`co_manager_added` / `co_manager_removed`).
 */
@Entity('listing_co_managers')
@Unique('UQ_listing_co_managers_listing_user', ['listingId', 'userId'])
// Composite, so it is declared at class level: TypeORM's property-level
// `@Index()` takes options only, never a column list.
@Index('IDX_listing_co_managers_user_id_status', ['userId', 'status'])
export class ListingCoManager {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // FK to `listings(id)` ON DELETE CASCADE — see the class doc comment.
  @Index('IDX_listing_co_managers_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  /**
   * The member holding the seat.
   *
   * Indexed on `(user_id, status)` rather than on `user_id` alone, because the
   * two reads that use this column both filter on status: "which listings do I
   * co-manage" (`status = 'active'`, feeding `GET /listings/mine`) and "what am
   * I invited to" (`status = 'invited'`).
   */
  @Column({ type: 'uuid' })
  userId!: string;

  // FK to `users(id)` ON DELETE CASCADE.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /** The owner who sent the current invitation. Null once that account is
   * erased; the seat itself is unaffected. */
  @Column({ type: 'uuid', nullable: true })
  invitedByUserId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL.
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by_user_id' })
  invitedBy!: User | null;

  @Column({
    type: 'enum',
    enum: ListingCoManagerStatus,
    enumName: 'listing_co_managers_status_enum',
    default: ListingCoManagerStatus.Invited,
  })
  status!: ListingCoManagerStatus;

  /** When the current invitation was sent. Rewritten on a re-invite, so it
   * always describes the invitation the `status` is about. */
  @Column({ type: 'timestamptz' })
  invitedAt!: Date;

  /** When the member accepted. Cleared on a re-invite, so it is never a
   * timestamp from a seat that already ended. */
  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  /** When the seat ended, whichever way it ended (declined, revoked, left).
   * Null while the row is `invited` or `active`. */
  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/** The two statuses that occupy a seat. A member in either one may not be
 * invited again, and both count toward the per-listing cap. */
export const LIVE_LISTING_CO_MANAGER_STATUSES: readonly ListingCoManagerStatus[] =
  [ListingCoManagerStatus.Invited, ListingCoManagerStatus.Active];
