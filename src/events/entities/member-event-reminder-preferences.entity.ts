import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

// 1 day before the event — the fixed behaviour every member had before this
// preference existed, so a member who never opens event settings (no row) keeps
// getting reminders exactly as they did. The column default below and the
// service's synthesised default must stay in lockstep with this.
export const DEFAULT_REMINDER_LEAD_MINUTES = 1440;

// The closed set the UI offers: 1 hour / 1 day / 1 week. Anything outside this
// is rejected by the DTO — the cron does arithmetic with the value, so an
// arbitrary integer must never reach it.
export const ALLOWED_REMINDER_LEAD_MINUTES = [60, 1440, 10080] as const;

/**
 * One row per member holding their event-reminder preference. Currently just
 * the lead time (how long before an event the reminder fires); channels are not
 * stored here because push is governed by the member's Web Push subscription
 * and email/in-app have no per-member switch yet.
 *
 * `user_id` is both PK and the 1:1 key to `users`, mirroring `member_preferences`
 * — this is a singleton settings row, not a sparse per-category override set.
 */
@Entity('member_event_reminder_preferences')
export class MemberEventReminderPreferences {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'int', default: DEFAULT_REMINDER_LEAD_MINUTES })
  leadMinutes: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
