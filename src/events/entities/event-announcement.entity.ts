import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One message a host or co-host sent to everybody holding a stake in their
 * gathering (LOC-06): "we moved to the back room", "the door code is 4471",
 * "the tram is out, walk up from Martim Moniz".
 *
 * WHY IT IS PERSISTED rather than fired and forgotten. A notification is a
 * moment, and the moment passes: a member who reads "the door code is 4471"
 * on the tram needs to find it again at the door, and a host part-way through
 * the evening needs to know what they have already said. The row is the
 * record; the notification fan-out is only how it travels.
 *
 * DELIVERY IS IN-APP PLUS PUSH. QueerPulse sends no email and never will, so
 * nothing here may be described as one.
 *
 * `authorId` is `ON DELETE SET NULL` for the same reason `events.host_id` is
 * (`SetNullContentAuthorFksOnUserErasure1794610000000`): erasing the host's
 * account must not delete the announcement everybody planned their evening
 * around. NULL reads as "a former organiser".
 */
@Entity('event_announcements')
@Index('IDX_event_announcements_event_id_created_at', ['eventId', 'createdAt'])
export class EventAnnouncement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  /** The host's own words, plain text. Never HTML: stored as typed and
   *  rendered as text, so there is no strip step to forget at a render site. */
  @Column({ type: 'text' })
  body!: string;

  /** How many members the fan-out actually reached, recorded at send time so
   *  the host's sent list can say "went to 14 people" without recomputing a
   *  roster that has since changed. */
  @Column({ type: 'int', default: 0 })
  recipientCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
