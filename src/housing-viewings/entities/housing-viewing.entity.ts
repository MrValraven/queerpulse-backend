import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** How the viewing happens. Video-call-first is the research-backed anti-scam
 * default ("see it live before you pay"); in-person is the traditional visit. */
export enum HousingViewingMode {
  InPerson = 'in_person',
  Video = 'video',
}

/**
 * Booking-protection-style lifecycle for a viewing request.
 *  requested → accepted | declined | cancelled
 *  accepted  → completed | cancelled
 * `completed` is the ONLY terminal state that records a real interaction — it
 * is the gate the two-sided blind reviews (P2.4) hang off, and (together with
 * `accepted`) it unlocks the listing's precise address for the requester.
 */
export enum HousingViewingStatus {
  Requested = 'requested',
  Accepted = 'accepted',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Completed = 'completed',
}

/** Whose proposal of time slots is currently on the table. The counter-party
 * (the one who did NOT last propose) is the one who may accept it — so this is
 * the "whose turn" marker for the accept/propose ping-pong. */
export enum HousingViewingParty {
  Requester = 'requester',
  Lister = 'lister',
}

/**
 * A request to view a specific housing listing, in person or over video. The
 * enquirer proposes one or more time slots + a note; the lister accepts a slot,
 * proposes alternatives, or declines. Kept in its own module — it references a
 * `housing_listings` row by id but never mutates one.
 */
@Entity('housing_viewings')
export class HousingViewing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_housing_viewings_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  // The enquirer who asked for the viewing.
  @Index('IDX_housing_viewings_requester_id')
  @Column({ type: 'uuid' })
  requesterId!: string;

  // Denormalized listing owner, so "my viewings as the lister" is a single
  // indexed lookup with no join back to housing_listings.
  @Index('IDX_housing_viewings_lister_id')
  @Column({ type: 'uuid' })
  listerId!: string;

  @Column({
    type: 'enum',
    enum: HousingViewingMode,
    enumName: 'housing_viewing_mode_enum',
  })
  mode!: HousingViewingMode;

  @Index('IDX_housing_viewings_status')
  @Column({
    type: 'enum',
    enum: HousingViewingStatus,
    enumName: 'housing_viewing_status_enum',
    default: HousingViewingStatus.Requested,
  })
  status!: HousingViewingStatus;

  @Column({
    type: 'enum',
    enum: HousingViewingParty,
    enumName: 'housing_viewing_party_enum',
    default: HousingViewingParty.Requester,
  })
  proposedBy!: HousingViewingParty;

  // One or more proposed start times (the party whose turn it is picks one to
  // accept). Replaced wholesale when the other side counter-proposes.
  @Column({ type: 'timestamptz', array: true })
  proposedSlots!: Date[];

  // The slot both sides agreed on — set only on transition to `accepted`.
  @Column({ type: 'timestamptz', nullable: true })
  acceptedSlot!: Date | null;

  // The enquirer's opening note.
  @Column({ type: 'text', default: '' })
  note!: string;

  // The lister's (or counter-proposer's) reply note on decline/propose.
  @Column({ type: 'text', nullable: true })
  responseNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
