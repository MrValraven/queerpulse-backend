/**
 * The shape `/admin/moderation/queue-health` serves, plus the pure mapper that
 * builds it (TS-04).
 *
 * DTO + mapper only (no DB access, no Nest decorators), mirroring
 * `../admin-overview/admin-overview-response.ts`, so the severity arithmetic
 * stays directly unit-testable without a testing module. There is no global
 * serializer in this repo: every field below is hand-mapped from a
 * measurement, and no entity is ever returned.
 */
import {
  MODERATION_QUEUE_THRESHOLDS,
  ModerationQueueBreachAxis,
  ModerationQueueKey,
  ModerationQueueSeverity,
  ModerationQueueThresholds,
  severityForQueue,
  worstSeverity,
} from './moderation-queue-thresholds';

/**
 * What the health service measured for one queue, before thresholds are
 * applied. The service produces these; this file turns them into the DTO.
 */
export interface ModerationQueueMeasurement {
  queue: ModerationQueueKey;
  /** Items waiting in this queue right now. */
  depth: number;
  /** Waiting items already past that queue's own published clock. */
  overdueCount: number;
  /**
   * Waiting items nobody has claimed. `null` for the queues that carry no
   * assignment column at all (appeals, ban ratifications), which is a
   * different statement from "nobody has claimed any of them" and must not
   * render as a zero.
   */
  unassignedCount: number | null;
  /** Hours the oldest waiting item has waited. `null` when the queue is empty. */
  oldestItemHours: number | null;
  /**
   * Median hours from arrival to decision over the trailing response window.
   * `null` when the queue publishes no such figure, or when nothing was
   * decided inside the window.
   */
  medianResponseHours: number | null;
}

/** One queue as the admin console reads it. */
export interface ModerationQueueHealthEntryDTO {
  /** Stable key from `ModerationQueueKey`; the client keys its copy off this. */
  queue: ModerationQueueKey;
  depth: number;
  overdueCount: number;
  unassignedCount: number | null;
  oldestItemHours: number | null;
  medianResponseHours: number | null;
  /**
   * `depth` divided by the number of active moderators, to one decimal.
   * `null` when there are no active moderators: an undefined division, and a
   * far louder fact than any number this field could carry.
   */
  depthPerModerator: number | null;
  severity: ModerationQueueSeverity;
  /** Which axes are at or above their own warning level. Empty when `ok`. */
  breaches: ModerationQueueBreachAxis[];
  /** The bands this queue's severity was decided against. */
  thresholds: ModerationQueueThresholds;
}

/** The whole workload picture. */
export interface ModerationQueueHealthDTO {
  /** ISO instant the measurement was taken. */
  generatedAt: string;
  /** The worst of every queue's severity. Never an average. */
  overallSeverity: ModerationQueueSeverity;
  /**
   * Active accounts holding the platform `moderator` or `admin` tier, the
   * people who can work every queue below. This is what makes
   * `depthPerModerator` answerable, and what makes "the queue is fine, there
   * are just no moderators left" visible.
   */
  activeModeratorCount: number;
  queues: ModerationQueueHealthEntryDTO[];
}

/** `value` rounded to one decimal place, or `null` passed through. */
function roundToOneDecimal(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10) / 10;
}

/**
 * Turns raw measurements into the served DTO: applies each queue's thresholds,
 * derives the per-moderator load, and rolls the queue severities up into one
 * overall severity.
 *
 * Queues arrive in whatever order the service measured them and are emitted in
 * that same order; the service measures them in `MODERATION_QUEUE_KEYS` order,
 * which is the order the console lists them in.
 */
export function toModerationQueueHealthDTO(
  measurements: ModerationQueueMeasurement[],
  activeModeratorCount: number,
  generatedAt: Date,
): ModerationQueueHealthDTO {
  const queues = measurements.map((measurement) => {
    const { severity, breaches } = severityForQueue(measurement.queue, {
      depth: measurement.depth,
      overdueCount: measurement.overdueCount,
      oldestItemHours: measurement.oldestItemHours,
    });
    return {
      queue: measurement.queue,
      depth: measurement.depth,
      overdueCount: measurement.overdueCount,
      unassignedCount: measurement.unassignedCount,
      oldestItemHours: roundToOneDecimal(measurement.oldestItemHours),
      medianResponseHours: roundToOneDecimal(measurement.medianResponseHours),
      depthPerModerator:
        activeModeratorCount > 0
          ? roundToOneDecimal(measurement.depth / activeModeratorCount)
          : null,
      severity,
      breaches,
      thresholds: MODERATION_QUEUE_THRESHOLDS[measurement.queue],
    };
  });

  const overallSeverity = queues.reduce<ModerationQueueSeverity>(
    (worst, entry) => worstSeverity(worst, entry.severity),
    'ok',
  );

  return {
    generatedAt: generatedAt.toISOString(),
    overallSeverity,
    activeModeratorCount,
    queues,
  };
}
