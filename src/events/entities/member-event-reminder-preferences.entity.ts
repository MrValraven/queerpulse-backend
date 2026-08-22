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

// The default visibility a member's own events are created with when they have
// never chosen one. `connections` mirrors the frontend's `DEFAULT_PREFS`, and
// the column default below plus the service's synthesised default must stay in
// lockstep with this.
export const EVENT_VISIBILITY_OPTIONS = [
  'public',
  'connections',
  'private',
] as const;
export type EventVisibility = (typeof EVENT_VISIBILITY_OPTIONS)[number];
export const DEFAULT_EVENT_VISIBILITY: EventVisibility = 'connections';

// Event email notifications are on by default — a member who never opens event
// settings (no row) keeps the prior always-on behaviour.
export const DEFAULT_EVENT_EMAILS_ENABLED = true;

/**
 * One row per member holding their event preferences: the reminder lead time
 * (how long before an event the reminder fires), the default visibility their
 * own events are created with, and whether event email notifications are on.
 * Push is not stored here — it is governed by the member's Web Push
 * subscription.
 *
 * `user_id` is both PK and the 1:1 key to `users`, mirroring `member_preferences`
 * — this is a singleton settings row, not a sparse per-category override set.
 */
@Entity('member_event_reminder_preferences')
export class MemberEventReminderPreferences {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'int', default: DEFAULT_REMINDER_LEAD_MINUTES })
  leadMinutes!: number;

  // -> default_event_visibility (SnakeNamingStrategy). Stored as a short varchar
  // rather than a Postgres enum so future options don't need a type migration;
  // the DTO's @IsIn is the closed-set guard.
  @Column({ type: 'varchar', length: 20, default: DEFAULT_EVENT_VISIBILITY })
  defaultEventVisibility!: EventVisibility;

  // -> event_emails_enabled (SnakeNamingStrategy).
  @Column({ type: 'boolean', default: DEFAULT_EVENT_EMAILS_ENABLED })
  eventEmailsEnabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
