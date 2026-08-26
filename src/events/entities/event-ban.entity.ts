import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One member a host or co-host barred from their gathering (LOC-08).
 *
 * Before this existed, a host afraid of one person had exactly two tools:
 * remove them (and watch them RSVP again a second later, because
 * `RsvpService.rsvp` read a cancelled row as a first RSVP), or cancel the
 * whole gathering. A ban is checked in `assertMayRsvp`, the same guard the
 * audience tiers go through, so it holds on every write path into the roster.
 *
 * Deliberately NOT a platform block. A block is a mutual, whole-account
 * severance the member owns; this is one host saying "not at my table",
 * scoped to one gathering, and it says nothing about either person anywhere
 * else on the platform. Blocks are checked too, in the same guard, from the
 * member's own side.
 *
 * `bannedByUserId` is `ON DELETE SET NULL` so an erased organiser's account
 * does not quietly reopen the door.
 */
@Entity('event_bans')
@Unique('UQ_event_bans', ['eventId', 'userId'])
export class EventBan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_bans_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Index('IDX_event_bans_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  bannedByUserId!: string | null;

  /** The organiser's own note, for their own list. NEVER sent to the banned
   *  member and never carried in a notification payload: a host must be able
   *  to write "made two people uncomfortable at the last one" without it
   *  becoming a message to the person it is about. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
