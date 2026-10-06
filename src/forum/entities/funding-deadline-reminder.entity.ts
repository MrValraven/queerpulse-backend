import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type FundingReminderStageValue = '7d' | '1d';

/**
 * One deadline reminder already sent: member, call, stage and the deadline it
 * was about. `FundingDeadlineReminderService` inserts these with
 * `ON CONFLICT DO NOTHING` and notifies only for the rows that actually went
 * in, so a crash-rerun or a second replica sends nothing twice.
 *
 * The deadline is part of the key on purpose: when a funder extends a call,
 * the new date is a new key, so savers earn fresh reminders for it.
 *
 * Both foreign keys cascade (migration `CreateFundingDeadlineReminder1828600100000`):
 * erasing an account or deleting a thread takes its reminders with it.
 */
@Entity('funding_deadline_reminder')
@Index('IDX_funding_deadline_reminder_thread_id', ['threadId'])
export class FundingDeadlineReminder {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ type: 'uuid' })
  threadId!: string;

  @PrimaryColumn({ type: 'varchar', length: 4 })
  stage!: FundingReminderStageValue;

  @PrimaryColumn({ type: 'timestamptz', precision: 3 })
  deadline!: Date;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  sentAt!: Date;
}
