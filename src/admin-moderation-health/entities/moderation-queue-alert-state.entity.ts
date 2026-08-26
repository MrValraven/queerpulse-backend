import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ModerationQueueKey } from '../moderation-queue-thresholds';

/**
 * One row per queue that currently has an OPEN alert (TS-04).
 *
 * This table is the deduplication. The alert cron runs hourly, so a queue that
 * stays critical for a day would otherwise raise twenty-four identical alerts;
 * the row below says "we already told them, at this severity, at this
 * instant", and the cron only speaks again when the ANSWER changes:
 *
 *   - no row + `warning`/`critical`  -> alert, insert the row
 *   - row at the same severity       -> say nothing
 *   - row at `warning` + `critical`  -> escalation: alert again, update the row
 *   - row at `critical` + `warning`  -> improving but not fixed: no new alert,
 *                                       the row is lowered so a later climb
 *                                       back to critical earns a fresh one
 *   - row + `ok`                     -> one recovery notice, delete the row
 *
 * PRESENCE IS THE STATE. A missing row means "this queue is fine and nobody
 * is owed an update", which is also the correct reading on a brand new
 * database. There is no `severity = 'ok'` row, so the table holds one row per
 * queue currently in trouble, and usually none.
 *
 * KEEPING THAT TRUE takes one deliberate step. The cron walks the LIVE queue
 * list, so a row whose key was later retired from `ModerationQueueKey` would
 * never be visited, never recovered and never deleted, and the sentence above
 * would quietly stop being true. `ModerationQueueAlertService.reapOrphanedStates`
 * closes that at the end of every sweep.
 *
 * A ROW IS ONLY EVER WRITTEN FOR AN ALERT THAT WAS ACTUALLY DELIVERED. The row
 * is what tells the next tick "they already know", so writing one for a
 * notification that reached nobody makes the queue go silent while still
 * breaching. `ModerationQueueAlertService` writes the row only after the
 * notification lands, and deletes it only after the closing notice does.
 *
 * WHY A TABLE RATHER THAN MEMORY OR AN EXISTING SETTINGS ROW. In-process state
 * (the shape `NotificationPushThrottleService` uses, correctly, for a push
 * throttle) is wrong for this one: the API restarts on every Railway deploy,
 * and a restart would clear the memory and re-raise every open alert as if it
 * were new. Deploys are frequent; a "critical" that re-announces itself after
 * each one is exactly the noise this feature exists to prevent.
 *
 * `platform_settings` was the other candidate: it already exists, and it
 * already carries operational flags. It is a deliberate SINGLE row (a
 * `CHECK (id = 1)` constraint, see that entity's doc) with one column per
 * setting, so per-queue state there would mean two new columns per queue and a
 * migration every time a queue is added. This table takes a new queue with no
 * schema change at all, which is the difference that decides it.
 *
 * `queue` is the primary key, stored as `varchar` holding a
 * {@link ModerationQueueKey} value rather than a Postgres enum: adding a queue
 * is then a code-only change (the same argument
 * `NotificationPreferenceCategory` makes for staying a plain string), and the
 * writer is a single cron in this module, so there is no untrusted input to
 * guard at the column.
 */
@Entity('moderation_queue_alert_state')
export class ModerationQueueAlertState {
  /** A `ModerationQueueKey` value. One row per queue, at most. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  queue!: ModerationQueueKey;

  /**
   * The severity the last alert was raised at: `warning` or `critical`, never
   * `ok`. A recovered queue has no row.
   */
  @Column({ type: 'varchar', length: 16 })
  severity!: 'warning' | 'critical';

  /**
   * When that alert was raised. Kept for the operator answering "how long has
   * this been on fire?" from the database alone, and for the structured log
   * line the cron writes.
   */
  @Column({ type: 'timestamptz' })
  alertedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
