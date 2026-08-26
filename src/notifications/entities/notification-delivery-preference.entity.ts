import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A member's delivery-window settings: quiet hours, and the time zone the
 * window is measured in.
 *
 * **Sparse**, like `notification_preferences`: a row exists only once a member
 * has actually set a window. No row means quiet hours are off, which is what
 * every member had before this table existed.
 *
 * Quiet hours suppress the PUSH channel only. The in-app row is always written,
 * so nothing is ever lost: the buzz is withheld, the notification is waiting in
 * the bell. That is the whole contract, and `PushService.sendToUsers` is the
 * single chokepoint that enforces it.
 *
 * The window is stored as two minute-of-day integers (0..1439) rather than two
 * `time` columns, because the only question ever asked of it is "is the
 * member's local clock inside this range right now?", which is integer
 * comparison. A window that wraps midnight (22:00 to 08:00, the common case)
 * is simply `start > end` and is handled by the comparison, not by the schema.
 *
 * `timeZone` is an IANA name (`Europe/Lisbon`), never a fixed UTC offset: an
 * offset silently drifts an hour when the member's region changes to or from
 * summer time, and "quiet hours moved by an hour in October" is exactly the
 * kind of quiet betrayal this feature exists to stop. Validated at the DTO
 * boundary against the runtime's own zone database.
 */
@Entity('notification_delivery_preferences')
export class NotificationDeliveryPreference {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  /** Whether the window below is enforced at all. */
  @Column({ type: 'boolean', default: false })
  isQuietHoursEnabled!: boolean;

  /** Minute-of-day the window opens, 0..1439. Default 22:00. */
  @Column({ type: 'smallint', default: 22 * 60 })
  quietHoursStartMinute!: number;

  /** Minute-of-day the window closes, 0..1439. Default 08:00. */
  @Column({ type: 'smallint', default: 8 * 60 })
  quietHoursEndMinute!: number;

  /** IANA zone the two minutes above are read in. */
  @Column({ type: 'varchar', length: 64, default: 'UTC' })
  timeZone!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
