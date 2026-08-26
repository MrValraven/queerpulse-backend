import { registerAs } from '@nestjs/config';

// Age thresholds (in days) and batch sizing for the background retention crons
// that keep row-accreting stores from growing forever:
//   - AccountRetentionService      (data_export_job archives, account_reauth_token)
//   - NotificationRetentionService (read notifications)
//   - PushSubscriptionRetentionService (stale push subscriptions)
//   - EventAttendanceRetentionService  (past gatherings' attendance details)
//
// All are optional overrides — the defaults below are production-safe. They are
// validated as optional positive numbers in src/config/env.validation.ts so a
// typo fails fast at boot instead of silently disabling a retention job.
function positiveIntOrDefault(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default registerAs('retention', () => ({
  /**
   * A data-export archive's JSONB payload is nulled and its status flipped to
   * `expired` this many days after it was generated. 30 days matches the
   * refresh-token grace window and is long enough for a member to download.
   */
  dataExportArchiveDays: positiveIntOrDefault(
    process.env.DATA_EXPORT_RETENTION_DAYS,
    30,
  ),
  /**
   * Read notifications older than this are deleted. Unread notifications are
   * never touched, however old — a member who hasn't seen it still needs it.
   */
  notificationReadDays: positiveIntOrDefault(
    process.env.NOTIFICATION_RETENTION_DAYS,
    90,
  ),
  /**
   * Push subscriptions not successfully delivered to (nor created) within this
   * window are pruned as stale. Hard failures (404/410) are already deleted
   * inline by PushService at send time; this catches devices that simply went
   * quiet without ever returning a gone status.
   */
  pushSubscriptionStaleDays: positiveIntOrDefault(
    process.env.PUSH_SUBSCRIPTION_STALE_DAYS,
    90,
  ),
  /**
   * How long after a gathering ENDS its attendance detail is kept, before
   * `EventAttendanceRetentionService` clears it. 30 days is not a free choice:
   * it is the period the published privacy policy already promises members
   * ("gathering attendance 30 days after the event"), so lengthening it here
   * puts the deployment out of step with what its own members were told. Treat
   * this as a ceiling that may be lowered, never raised.
   */
  eventAttendanceDays: positiveIntOrDefault(
    process.env.EVENT_ATTENDANCE_RETENTION_DAYS,
    30,
  ),
  /** Rows removed/updated per statement inside each retention loop. */
  batchSize: positiveIntOrDefault(process.env.RETENTION_BATCH_SIZE, 1000),
  /** Hard cap on batches per run so one tick can never loop unbounded. */
  maxBatchesPerRun: positiveIntOrDefault(
    process.env.RETENTION_MAX_BATCHES_PER_RUN,
    50,
  ),
}));
