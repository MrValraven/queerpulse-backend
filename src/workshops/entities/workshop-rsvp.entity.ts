import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Where a member stands on a workshop's roster.
 *
 * Shape follows `EventRsvp`'s `RsvpStatus` with **one deliberate omission**:
 * there is no `maybe`. An event RSVP is a social signal — "maybe" is a real and
 * useful answer to a Friday drinks invite. A workshop seat is a scarce, priced,
 * multi-week commitment measured against `spots_total`; a "maybe" would either
 * hold a seat it might not use (starving the waitlist) or hold none while
 * looking like it does. Either way the host's `spots_filled` stops meaning
 * "people who are coming", which is the only number a workshop needs. So the
 * set is binary-plus-queue: you have a seat, you are queued for one, or you
 * withdrew.
 *
 * `cancelled` is retained rather than deleting the row, exactly as `EventRsvp`
 * does — it keeps the (workshop, user) UNIQUE constraint as the single place a
 * member's relationship to a workshop lives, so re-booking updates one row
 * instead of racing an insert against a stale delete.
 */
export enum WorkshopRsvpStatus {
  Going = 'going',
  Waitlist = 'waitlist',
  Cancelled = 'cancelled',
}

@Entity('workshop_rsvps')
@Unique('UQ_workshop_rsvps', ['workshopId', 'userId'])
export class WorkshopRsvp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_workshop_rsvps_workshop_id')
  @Column({ type: 'uuid' })
  workshopId: string;

  @Index('IDX_workshop_rsvps_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: WorkshopRsvpStatus,
    enumName: 'workshop_rsvp_status_enum',
  })
  status: WorkshopRsvpStatus;

  /**
   * When this member joined the queue — the waitlist's FIFO ordering.
   *
   * `EventRsvp` uses an integer `waitlist_position` instead, because events
   * *show* organizers the position ("#3 on the waitlist") and the API returns
   * it. Workshops never surface a position: the RSVP response is
   * `{ status, spotsFilled, spotsTotal }` and the sidebar says "you're on the
   * waitlist", not where. Storing an integer we never read would be a second
   * source of truth that can drift out of order under concurrent promotion for
   * no user-visible gain, so the queue is ordered by this timestamp.
   *
   * It is stamped on *entry* to the waitlist, not on row creation, which is the
   * whole reason it is not just `created_at`: a member who cancels and later
   * re-books reuses this row, and must join the back of the queue rather than
   * inheriting their original `created_at` and jumping it.
   *
   * NULL whenever `status` is not `waitlist`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  waitlistedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
