import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per staff member who has ever dismissed the desk's "Since Friday"
 * notifications panel — `lastReadAt` is the cutoff `listMagazineNotifications`
 * compares each `magazine_piece_event` against to flag it read/unread. A
 * viewer with no row yet has never dismissed anything, so every event reads
 * as unread (handled by the service treating a missing row as "never read").
 */
@Entity('magazine_notification_reads')
export class MagazineNotificationRead {
  @PrimaryColumn({ type: 'uuid' })
  actorId!: string;

  @Column({ type: 'timestamptz' })
  lastReadAt!: Date;
}
