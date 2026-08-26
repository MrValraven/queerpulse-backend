/**
 * When a moderator queue counts as busy, late, or out of hand (TS-04).
 *
 * ONE PLACE, ON PURPOSE: the same promise `membership/join-request-sla.ts`
 * and `verification/verification-sla.ts` make about their review windows.
 * Nothing else in the codebase may hard-code a queue threshold: the health
 * read (`/admin/moderation/queue-health`), the hourly alert cron and the
 * Prometheus gauges all colour their numbers from the table below, so a
 * threshold moves in one edit and every surface moves with it.
 *
 * THREE AXES. A queue can be unhealthy in three independent ways, and a
 * single "depth" number hides two of them:
 *
 *  1. DEPTH: how many items are waiting. Says how much work there is.
 *  2. OLDEST: how long the oldest waiting item has been waiting, in hours.
 *     Says whether the queue is being worked at all. A queue of three that
 *     nobody has touched in a week is worse than a queue of thirty filed this
 *     morning.
 *  3. OVERDUE: how many items are past the queue's OWN published clock
 *     (`join_requests.due_at`, `reports.sla_due_at`, `appeals.sla_due_at`,
 *     `verification_requests.due_at`, `ban_ratifications.expires_at`). Says
 *     how many promises are already broken. This is the axis that is not a
 *     judgement call: the window was published, and the row is past it.
 *
 * A queue's severity is the WORST of the three (see `severityForQueue`), and
 * the whole picture's severity is the worst of the queues. Nothing averages:
 * one broken promise is not cancelled out by four healthy queues.
 *
 * WHY CONSTANTS AND NOT ENVIRONMENT VARIABLES. This repo's config convention
 * is `src/config/*` namespaced factories validated by `env.validation.ts`,
 * which fails the boot when a variable is missing or malformed. Fifteen
 * numbers behind that machinery would be fifteen more ways for a deploy to
 * refuse to start, and every one of them is a POLICY decision about what the
 * platform owes an applicant or a reported member, the kind of decision that
 * belongs in a reviewed commit next to its reasoning, not in a Railway
 * dashboard where it can be quietly turned down until the alert stops firing.
 * The review windows these numbers derive from are already constants for
 * exactly that reason. If a number here is wrong, the fix is to change it here
 * and say why.
 *
 * NOTHING HERE IS MEMBER-FACING. Every number below describes staff workload
 * and is served only to moderators and admins.
 */
import { JOIN_REQUEST_REVIEW_WINDOW_MS } from '../membership/join-request-sla';
import { APPEAL_DECISION_WINDOW_MS } from '../moderation/appeal-window';
import { VERIFICATION_REVIEW_WINDOW_MS } from '../verification/verification-sla';

const HOUR_MS = 60 * 60 * 1000;

/** The queues a moderator actually works, as one stable vocabulary. */
export enum ModerationQueueKey {
  /**
   * `join_requests` in `pending` OR `waitlisted`: strangers asking to join
   * the platform.
   *
   * WAITLISTED IS IN SCOPE, and it is the one status decision on this list
   * worth arguing. The opposite reading is available: a waitlisted applicant
   * has already had one answer, so the row could be called parked rather than
   * waiting. Three facts in the membership module settle it the other way.
   * `JoinRequestsService.decideJoinRequest` names Pending and Waitlisted
   * together as "both open states a review can act on"; `setAssignment`'s
   * `claimableStatuses` lets a moderator claim either, which only makes sense
   * for a row that is still work; and `due_at` is stamped once at submission
   * (`join-requests.service.ts`) and is never cleared by waitlisting, so the
   * three-day promise keeps running on a waitlisted row. Migration
   * `AddQueueAssignmentAndDueClocks1795640000000` backfilled `due_at` for both
   * statuses for the same reason.
   *
   * So the platform's own stored clock says a waitlisted applicant is still
   * owed an answer, and excluding them would report thirty three-week-old
   * waitlisted requests as `depth: 0, severity: ok` while thirty published
   * promises sat broken. If the intent is ever genuinely "parked", the honest
   * change is to clear `due_at` at waitlist time in the membership module, and
   * this queue would then stop counting them with no edit here.
   */
  InviteRequests = 'invite_requests',
  /** `reports` in `open` or `escalated`: member-filed reports. */
  Reports = 'reports',
  /** `appeals` in `awaiting`: members contesting a moderation decision. */
  Appeals = 'appeals',
  /** `verification_requests` in `pending`, `in_review` or `appealing`. */
  Verification = 'verification',
  /** `ban_ratifications` in `pending`: a permanent ban waiting on its second signature. */
  BanRatifications = 'ban_ratifications',
}

/** Every queue, in the order the health response lists them. */
export const MODERATION_QUEUE_KEYS: readonly ModerationQueueKey[] =
  Object.values(ModerationQueueKey);

/**
 * How bad one number (or one queue, or the whole picture) is.
 *
 * Three levels and no more. `ok` means nothing to say. `warning` means a human
 * should plan to work this queue. `critical` means the platform is already
 * failing somebody: a published window has passed, or the backlog can no
 * longer be cleared by whoever is on rota.
 */
export type ModerationQueueSeverity = 'ok' | 'warning' | 'critical';

/** Which of the three axes drove a queue's severity. */
export type ModerationQueueBreachAxis = 'depth' | 'oldest' | 'overdue';

/** A warning level and the critical level above it, for one axis. */
export interface ModerationQueueThresholdBand {
  warning: number;
  critical: number;
}

/** The three bands that decide one queue's severity. */
export interface ModerationQueueThresholds {
  /** Items waiting. */
  depth: ModerationQueueThresholdBand;
  /** Hours the oldest waiting item has been waiting. */
  oldestHours: ModerationQueueThresholdBand;
  /** Items already past that queue's own published clock. */
  overdue: ModerationQueueThresholdBand;
}

/** The published review window a queue's `oldestHours` band is derived from. */
const JOIN_REQUEST_WINDOW_HOURS = JOIN_REQUEST_REVIEW_WINDOW_MS / HOUR_MS;
const APPEAL_WINDOW_HOURS = APPEAL_DECISION_WINDOW_MS / HOUR_MS;
const VERIFICATION_WINDOW_HOURS = VERIFICATION_REVIEW_WINDOW_MS / HOUR_MS;

/**
 * The whole policy, one entry per queue.
 *
 * Every `oldestHours.critical` below is a queue's OWN published window read
 * off its `*-sla.ts` constant rather than retyped, so a window that moves
 * moves the alert with it. The `warning` level is deliberately inside the
 * window: the point of a warning is that there is still time to keep the
 * promise.
 *
 * The depth numbers are the ones with the least arithmetic behind them, and
 * they are stated as what they mean rather than dressed up: this is an
 * invite-only platform of a few thousand members run by volunteers, so a
 * warning level is "more than one person can clear in a sitting" and a
 * critical level is "more than a rota can clear this week". They are
 * intentionally low. A threshold nobody ever crosses alerts nobody.
 */
export const MODERATION_QUEUE_THRESHOLDS: Record<
  ModerationQueueKey,
  ModerationQueueThresholds
> = {
  /**
   * Invite requests, counting BOTH `pending` and `waitlisted` rows (see
   * `ModerationQueueKey.InviteRequests` for why waitlisted is work rather than
   * parked). The published window is three days
   * (`JOIN_REQUEST_REVIEW_WINDOW_MS`) and the person waiting has no account,
   * so they cannot see anything but a status page while they wait.
   *
   * Depth 15 / 40: an invite-only platform takes a handful of requests a week,
   * so fifteen pending means roughly a fortnight nobody has worked the queue,
   * and forty is more than a volunteer will read carefully in one sitting.
   * Oldest 48h / 72h: the critical level IS the published window, so it fires
   * the hour the promise breaks; the warning fires with a day still on the
   * clock. Overdue 1 / 5: one broken window is worth saying out loud once,
   * five means it is not being honoured as policy.
   */
  [ModerationQueueKey.InviteRequests]: {
    depth: { warning: 15, critical: 40 },
    oldestHours: { warning: 48, critical: JOIN_REQUEST_WINDOW_HOURS },
    overdue: { warning: 1, critical: 5 },
  },

  /**
   * Reports. Each row carries its own severity-derived `sla_due_at` (see
   * `reports/report-severity.ts`), and the outing/doxxing promise inside it is
   * one hour, so the OVERDUE axis is the sharp one here and the oldest-age
   * axis is the slow-burn backstop.
   *
   * Depth 10 / 25: a report is read, judged and answered one at a time, and
   * ten open at once already means somebody is working through a list rather
   * than answering as they land. Oldest 24h / 72h: no report should sit a full
   * day unlooked-at whatever its severity, and three days open is a report
   * nobody is going to answer without being told. Overdue 1 / 5: a report past
   * its own `sla_due_at` is a published promise already broken, so the warning
   * band starts at one.
   */
  [ModerationQueueKey.Reports]: {
    depth: { warning: 10, critical: 25 },
    oldestHours: { warning: 24, critical: 72 },
    overdue: { warning: 1, critical: 5 },
  },

  /**
   * Appeals. The published window is seven days (`APPEAL_DECISION_WINDOW_MS`),
   * and every appellant is living under the decision they are contesting while
   * they wait, which is why the warning level sits at four days rather than
   * six: a queue that only goes yellow on day six leaves one day to act.
   *
   * Depth 8 / 20: appeals are rarer than reports and each one is a longer read
   * (the original action, the audit trail, the member's argument), so eight is
   * already a full afternoon. Overdue 1 / 3: the seven-day window is published
   * to members in the constitution, so a single miss is a warning and three is
   * a pattern.
   */
  [ModerationQueueKey.Appeals]: {
    depth: { warning: 8, critical: 20 },
    oldestHours: { warning: 96, critical: APPEAL_WINDOW_HOURS },
    overdue: { warning: 1, critical: 3 },
  },

  /**
   * Verification requests. The highest-volume queue here and the lowest stakes
   * per item: a member who asked for a level they do not have yet is not
   * blocked from anything they could do yesterday, which is the argument
   * `verification-sla.ts` already makes for its five-day window.
   *
   * That is why this is the one queue with real slack on the overdue axis
   * (3 / 10 rather than 1 / 5): a slipped verification harms nobody today, and
   * a queue that goes red on a single slip would train moderators to ignore
   * the alert that also covers reports and appeals. Depth 20 / 50 for the same
   * reason. Oldest 96h / 120h: the critical level is the published five-day
   * window; the appeal window is shorter (three days) and those rows trip the
   * OVERDUE axis on their own clock, which is where the shorter promise is
   * actually enforced.
   */
  [ModerationQueueKey.Verification]: {
    depth: { warning: 20, critical: 50 },
    oldestHours: { warning: 96, critical: VERIFICATION_WINDOW_HOURS },
    overdue: { warning: 3, critical: 10 },
  },

  /**
   * Ban ratifications: a permanent ban waiting on its second moderator
   * (TS-12). Every pending row is a member suspended RIGHT NOW on one
   * moderator's signature alone (`BAN_INTERIM_SUSPENSION`), which is why this
   * queue has the tightest AGE band on the board.
   *
   * DEPTH 3 / 5, revised down in urgency from an earlier 1 / 3. One pending
   * hold is not a backlog, it is the normal shape of the platform for the
   * seventy-two hours after any permanent ban
   * (`BAN_RATIFICATION_WINDOW_HOURS`): the flow itself is what created the row
   * and it is actively soliciting the second signature. Alerting on it told
   * every moderator something one of them had just done, which is the fastest
   * way to teach a rota to ignore an alert channel that also carries reports
   * and appeals. Three concurrent pending permanent bans is a genuinely
   * unusual day and worth a look; five is worth stopping for.
   *
   * OLDEST 12h / 24h is where the real harm lives and it is unchanged. A hold
   * nobody has countersigned overnight has left somebody locked out for a
   * night with no second opinion, and the 72-hour window means the row will
   * sit there quietly until it lapses unless something says so. That axis
   * fires on a single row, which is the behaviour the old depth band was
   * reaching for and the right place to put it.
   *
   * OVERDUE 1 / 1: there is NO warning band on this axis on purpose. A row
   * still `pending` after its `expires_at` cannot happen while the lapse sweep
   * runs, so seeing one means the sweep is broken and a suspension is being
   * held open past its own expiry. That is not a busy queue, it is a fault.
   */
  [ModerationQueueKey.BanRatifications]: {
    depth: { warning: 3, critical: 5 },
    oldestHours: { warning: 12, critical: 24 },
    overdue: { warning: 1, critical: 1 },
  },
};

/**
 * THERE IS DELIBERATELY NO TIME-BASED REPEAT WINDOW HERE.
 *
 * An earlier revision carried a six-hour `MIN_REPEAT` that ran through
 * `NotificationPushThrottleService`, on top of the durable
 * `moderation_queue_alert_state` row. It was removed, because the only case
 * where a time window could bite was the one case where biting was wrong: a
 * queue that recovers and breaches again inside the window had its alert
 * dropped while the state row still recorded it as delivered, after which the
 * state machine read every later tick as "already told them" and the queue
 * went silent for good. See `ModerationQueueAlertService`'s docstring.
 *
 * The state row is now the whole dedup, and it is a dedup on STATE rather than
 * on time: it cannot suppress an alert about a situation nobody has been told
 * about yet, whatever the clock says. Every notification the cron writes now
 * corresponds to a genuine change in the answer.
 */

/**
 * How far back `medianResponseHours` looks.
 *
 * Seven days. Long enough that a quiet week still produces a number, short
 * enough that it describes how the queue is being worked NOW rather than how
 * it was worked last quarter. The admin overview's own median uses a 90-day
 * window because it is a reporting figure; this one is an operational one, and
 * a rota that fell over on Monday should not be flattered by March.
 */
export const MODERATION_QUEUE_RESPONSE_WINDOW_MS = 7 * 24 * HOUR_MS;

/** The worse of two severities. */
export function worstSeverity(
  first: ModerationQueueSeverity,
  second: ModerationQueueSeverity,
): ModerationQueueSeverity {
  if (first === 'critical' || second === 'critical') return 'critical';
  if (first === 'warning' || second === 'warning') return 'warning';
  return 'ok';
}

/**
 * One axis's severity. `critical` is checked first so a band whose two levels
 * are equal (ban ratifications' overdue axis) resolves to `critical` rather
 * than to an unreachable warning.
 *
 * `null` means the axis has nothing to say (an empty queue has no oldest
 * item), and never counts as a breach.
 */
export function severityForValue(
  value: number | null,
  band: ModerationQueueThresholdBand,
): ModerationQueueSeverity {
  if (value === null) return 'ok';
  if (value >= band.critical) return 'critical';
  if (value >= band.warning) return 'warning';
  return 'ok';
}

/** The raw numbers one queue's severity is decided from. */
export interface ModerationQueueMeasurements {
  depth: number;
  overdueCount: number;
  oldestItemHours: number | null;
}

/**
 * A queue's severity, and which axes drove it.
 *
 * The severity is the WORST axis, never an average: a queue with two items and
 * both of them a week past their published window is critical, and no amount
 * of shallowness makes that acceptable. `breaches` names every axis at or
 * above its own warning level, so the console can say WHY a queue is red
 * instead of only that it is.
 */
export function severityForQueue(
  queue: ModerationQueueKey,
  measurements: ModerationQueueMeasurements,
): {
  severity: ModerationQueueSeverity;
  breaches: ModerationQueueBreachAxis[];
} {
  const thresholds = MODERATION_QUEUE_THRESHOLDS[queue];
  const axisSeverities: [ModerationQueueBreachAxis, ModerationQueueSeverity][] =
    [
      ['depth', severityForValue(measurements.depth, thresholds.depth)],
      [
        'oldest',
        severityForValue(measurements.oldestItemHours, thresholds.oldestHours),
      ],
      [
        'overdue',
        severityForValue(measurements.overdueCount, thresholds.overdue),
      ],
    ];
  let severity: ModerationQueueSeverity = 'ok';
  const breaches: ModerationQueueBreachAxis[] = [];
  for (const [axis, axisSeverity] of axisSeverities) {
    severity = worstSeverity(severity, axisSeverity);
    if (axisSeverity !== 'ok') breaches.push(axis);
  }
  return { severity, breaches };
}
