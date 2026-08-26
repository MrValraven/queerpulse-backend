import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { ModerationQueueAlertState } from './entities/moderation-queue-alert-state.entity';
import { ModerationQueueHealthEntryDTO } from './moderation-queue-health-response';
import { ModerationQueueHealthService } from './moderation-queue-health.service';
import {
  MODERATION_QUEUE_KEYS,
  ModerationQueueKey,
  ModerationQueueSeverity,
} from './moderation-queue-thresholds';

/** What the state machine decided to do about one queue on this tick. */
type AlertDecision = 'raise' | 'escalate' | 'recover' | 'silent';

/**
 * The IN-APP half of moderator workload alerting (TS-04).
 *
 * `/metrics` is the machine half: `ModerationQueueHealthService` writes every
 * number to Prometheus gauges, and a real alerting consumer in front of that
 * endpoint (LB-05) will page on them with its own rules. This service is the
 * half that reaches a person TODAY, on a platform that has no such consumer
 * yet and no pager either.
 *
 * QueerPulse delivers NO email and never will (there is no mailer in this
 * codebase and none is coming), so "raise an alert" here means exactly one
 * thing: write a notification into the bell of every active moderator and
 * admin. No copy anywhere may describe this as anything being sent.
 *
 * WHAT KEEPS IT FROM BECOMING NOISE: THE STATE ROW, AND NOTHING ELSE.
 *
 * `moderation_queue_alert_state` holds one row per queue with an open alert,
 * and that row is the entire deduplication. A queue that stays critical for a
 * day produces ONE alert, not twenty-four. Escalation from warning to critical
 * produces a second, because that is genuinely new information. A critical
 * queue easing back to warning produces none, and lowers the row. Recovery
 * produces exactly one closing notice, so the queue that went red is also the
 * queue somebody sees go green.
 *
 * WHY THERE IS NO TIME-BASED THROTTLE ON TOP, though an earlier revision had
 * one. It ran the recipient list through `NotificationPushThrottleService`
 * with a six-hour window per queue and severity, and it was removed because it
 * could turn a breaching queue permanently silent. The walkthrough, one
 * process, no restart:
 *
 *   01:00  reports reach warning. Alert written, six-hour bucket marked,
 *          state row written.
 *   02:00  reports recover. Closing notice written, state row deleted.
 *   03:00  reports reach warning again. The bucket was marked two hours ago,
 *          so every recipient is dropped and NO notification is written. The
 *          state row is written anyway.
 *   04:00+ the decision is now `decide(warning, warning)` = silent, forever.
 *
 * The moderators' last word on that queue is "recovered" while it sits in
 * breach indefinitely. The same shape hit `escalate` (critical, down to
 * warning, back to critical inside the window). Two properties made it
 * unfixable in place rather than merely buggy: the throttle suppressed the
 * IN-APP write, which its own contract forbids ("a caller that suppresses a
 * push here must still have written the in-app row first"), and the only
 * situation where it ever bit was the oscillation above, which is exactly the
 * situation where suppression produces silence.
 *
 * So the throttle is gone from this path and the state row stands alone. It
 * dedups on STATE rather than on TIME, which is the property that matters: it
 * can never suppress an alert about a situation nobody has been told about
 * yet. A genuinely oscillating queue therefore gets one notification per real
 * transition, which is honest, bounded (a queue that oscillates is a queue
 * being actively worked), and self-limiting in a way that silence is not.
 *
 * Note this type is deliberately absent from `PushNotificationListener`'s push
 * whitelist, so it never reaches a phone at all: an operational alert about
 * queue depth is not worth waking somebody for, and the person it is for opens
 * the console anyway. That whitelist is where a future decision to push this
 * would be made.
 *
 * NO DISTRIBUTED LOCK, on purpose. The backend runs as a single replica and
 * already carries 27 other `@Cron` handlers on the same assumption. If that
 * ever changes, the write below is a single `INSERT ... ON CONFLICT DO UPDATE`
 * against a one-row-per-queue table, so the worst a second replica could do is
 * duplicate one notification fan-out; it cannot corrupt the state.
 *
 * EVERY BREACH IS ALSO LOGGED at WARN with a single structured line, whether
 * or not it alerted, so a queue's history is greppable in Railway even when
 * the dedup correctly kept quiet.
 */
@Injectable()
export class ModerationQueueAlertService {
  private readonly logger = new Logger(ModerationQueueAlertService.name);

  constructor(
    @InjectRepository(ModerationQueueAlertState)
    private readonly alertState: Repository<ModerationQueueAlertState>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly queueHealth: ModerationQueueHealthService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Hourly, which is the resolution the thresholds are written in: the
   * shortest `oldestHours.warning` on the board is twelve hours, so a tick
   * finer than an hour would only re-ask a question whose answer cannot have
   * changed.
   *
   * AT MINUTE 30, NOT ON THE HOUR. `CronExpression.EVERY_HOUR` fires at minute
   * zero, which is where every daily sweep in this repo already lands:
   * `EventAttendanceRetentionService` says in its own comment that it took
   * 05:00 because the daily crons deliberately sit one per hour and should not
   * contend for the same pool on the same tick. This handler runs seven
   * aggregate queries and then a notification fan-out, and at midnight it
   * would have joined eight other jobs on one instant. Half past leaves it
   * alone with the pool.
   *
   * Wrapped in try/catch for the reason every cron in this repo is: an
   * escaping rejection from a `@nestjs/schedule` handler becomes an
   * `unhandledRejection` that can take the process down, and the next tick
   * retries anyway.
   */
  @Cron('0 30 * * * *')
  async sweepQueueHealth(): Promise<void> {
    try {
      await this.checkQueues();
    } catch (error) {
      this.logger.error(
        `Moderation queue health sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  /**
   * One pass: measure every queue, log every breach, then act on whichever
   * queues changed state.
   *
   * Separate from the cron wrapper so a spec can await it directly and read
   * what it did, rather than asserting on a swallowed rejection.
   */
  async checkQueues(): Promise<void> {
    const health = await this.queueHealth.getQueueHealth();
    const openStates = await this.alertState.find();
    const stateByQueue = new Map<ModerationQueueKey, ModerationQueueAlertState>(
      openStates.map((state) => [state.queue, state]),
    );

    // Resolved once for the whole tick, not once per queue: five queues
    // breaching together must not mean five identical roster queries.
    let staffUserIds: string[] | null = null;
    const resolveStaff = async (): Promise<string[]> => {
      staffUserIds ??= await this.loadStaffRecipients();
      return staffUserIds;
    };

    for (const entry of health.queues) {
      const previous = stateByQueue.get(entry.queue) ?? null;
      const decision = this.decide(entry.severity, previous?.severity ?? null);

      if (entry.severity !== 'ok') {
        this.logBreach(entry, decision, previous);
      }

      switch (decision) {
        case 'raise':
        case 'escalate': {
          // THE STATE ROW FOLLOWS THE NOTIFICATION, never leads it. A row
          // written for an alert that was not actually delivered makes every
          // later tick read `decide(warning, warning)` as `silent`, and the
          // queue goes quiet for good while still breaching. So the row is
          // written only when somebody was genuinely told; otherwise the next
          // tick sees no row and tries again.
          const wasNotified = await this.notifyBreach(
            entry,
            await resolveStaff(),
          );
          if (wasNotified) {
            await this.rememberAlert(entry.queue, entry.severity);
          }
          break;
        }
        case 'recover': {
          // Same rule in the other direction: the row means "somebody was told
          // this queue was breaching and is owed the close". Deleting it
          // without delivering that close would drop the closing notice
          // permanently, so the row survives until the notice lands.
          const wasNotified = await this.notifyRecovery(
            entry,
            await resolveStaff(),
          );
          if (wasNotified) {
            await this.alertState.delete({ queue: entry.queue });
          }
          break;
        }
        case 'silent':
          // A queue that has eased from critical back to warning without
          // recovering keeps its row, lowered, so that climbing back to
          // critical later reads as a fresh escalation rather than as the same
          // alert already sent.
          if (
            previous &&
            entry.severity !== 'ok' &&
            previous.severity !== entry.severity
          ) {
            await this.alertState.update(
              { queue: entry.queue },
              { severity: entry.severity },
            );
          }
          break;
      }
    }

    await this.reapOrphanedStates(openStates);
  }

  /**
   * Delete state rows for queues that no longer exist.
   *
   * The loop above walks `health.queues`, so a row whose key has since been
   * removed from `ModerationQueueKey` is never visited: it is never recovered,
   * never deleted, and sits there forever contradicting the entity's promise
   * that the table only holds queues currently in trouble. Retiring a queue is
   * rare, so this normally issues no query at all.
   *
   * Computed from the rows already fetched at the top of the sweep rather than
   * as an unconditional `DELETE ... WHERE queue NOT IN (...)`, so the common
   * case (nothing orphaned) costs nothing.
   */
  private async reapOrphanedStates(
    openStates: ModerationQueueAlertState[],
  ): Promise<void> {
    const knownQueues = new Set<string>(MODERATION_QUEUE_KEYS);
    const orphanedQueues = openStates
      .map((state) => state.queue)
      .filter((queue) => !knownQueues.has(queue));
    if (!orphanedQueues.length) return;
    this.logger.warn(
      `moderation-queue-health reaping alert state for retired queue(s): ${orphanedQueues.join(', ')}`,
    );
    await this.alertState.delete({ queue: In(orphanedQueues) });
  }

  /**
   * The state machine, as a pure decision. `previousSeverity` is `null` when
   * no alert is currently open for the queue.
   *
   * `warning` after `critical` is `silent` rather than a second alert: the
   * queue is improving, and telling people it is "only" a warning now is not
   * information anybody needs at 3am. It is also not `recover`: the queue is
   * still breaching, and closing the alert would let a queue oscillate between
   * warning and critical while announcing a recovery it never had.
   */
  private decide(
    severity: ModerationQueueSeverity,
    previousSeverity: ModerationQueueSeverity | null,
  ): AlertDecision {
    if (severity === 'ok') {
      return previousSeverity ? 'recover' : 'silent';
    }
    if (!previousSeverity) return 'raise';
    if (severity === 'critical' && previousSeverity === 'warning') {
      return 'escalate';
    }
    return 'silent';
  }

  /**
   * One structured WARN line per breaching queue per tick, greppable in
   * Railway by the `moderation-queue-health` prefix. Written even when the
   * dedup kept quiet (`decision` says which), because "still critical, said
   * nothing, correctly" is exactly the thing an operator needs to be able to
   * reconstruct afterwards.
   */
  private logBreach(
    entry: ModerationQueueHealthEntryDTO,
    decision: AlertDecision,
    previous: ModerationQueueAlertState | null,
  ): void {
    const openSince = previous ? previous.alertedAt.toISOString() : 'new';
    this.logger.warn(
      `moderation-queue-health queue=${entry.queue} severity=${entry.severity} ` +
        `breaches=${entry.breaches.join(',') || 'none'} depth=${entry.depth} ` +
        `overdue=${entry.overdueCount} oldestHours=${entry.oldestItemHours ?? 'n/a'} ` +
        `moderators=${entry.depthPerModerator ?? 'n/a'}/mod decision=${decision} openSince=${openSince}`,
    );
  }

  /**
   * The alert itself. `createForRecipients` is called with NO actor argument,
   * exactly as `ReportNotificationsListener` calls it: this is duty mail, and
   * passing an actor would run the recipients' own block/mute lists over an
   * operational alert.
   */
  private async notifyBreach(
    entry: ModerationQueueHealthEntryDTO,
    staffUserIds: string[],
  ): Promise<boolean> {
    // Returns whether anything was written, because the caller uses that to
    // decide whether to record the alert as delivered. An empty roster (no
    // active moderator or admin holds the tier) is the one way this writes
    // nothing, and it must NOT be recorded as an alert nobody can see.
    if (!staffUserIds.length) return false;
    await this.notifications.createForRecipients(
      staffUserIds,
      NotificationType.ModerationQueueAlert,
      {
        source: 'moderation',
        queue: entry.queue,
        severity: entry.severity,
        depth: entry.depth,
        overdueCount: entry.overdueCount,
        oldestItemHours: entry.oldestItemHours,
      },
    );
    return true;
  }

  /**
   * The closing notice. Same type, with `severity: 'ok'`. One notification type
   * whose payload carries the level, mirroring how `ReportFiled` keeps its
   * four urgency levels in the payload rather than minting an enum value per
   * level.
   */
  private async notifyRecovery(
    entry: ModerationQueueHealthEntryDTO,
    staffUserIds: string[],
  ): Promise<boolean> {
    if (!staffUserIds.length) return false;
    await this.notifications.createForRecipients(
      staffUserIds,
      NotificationType.ModerationQueueAlert,
      {
        source: 'moderation',
        queue: entry.queue,
        severity: 'ok',
        depth: entry.depth,
        overdueCount: entry.overdueCount,
        oldestItemHours: entry.oldestItemHours,
      },
    );
    return true;
  }

  /** Insert-or-update the one row that says an alert is open for this queue. */
  private async rememberAlert(
    queue: ModerationQueueKey,
    severity: ModerationQueueSeverity,
  ): Promise<void> {
    // `ok` never reaches here (a recovered queue has its row deleted), but the
    // column's type says `warning | critical` and the compiler is entitled to
    // be told so rather than cast around.
    if (severity === 'ok') return;
    await this.alertState.upsert({ queue, severity, alertedAt: new Date() }, [
      'queue',
    ]);
  }

  /**
   * Who hears about it: every ACTIVE account on the platform `moderator` or
   * `admin` tier, and nobody else.
   *
   * A member can never receive this notification. The roster is a role query,
   * the route that serves the same numbers is behind the same two roles, and
   * the type carries no `NotificationPreferenceCategory`, so there is no
   * member-facing switch that could ever route it anywhere else.
   *
   * Additive staff GRANTS are deliberately not included: no grant opens any of
   * these five queues (`staff-roles.registry.ts` names invites, join requests,
   * verification, bans and the report queue among the surfaces no grant ever
   * opens), so telling a grant holder that a queue they cannot work is on fire
   * would be noise they can do nothing about.
   */
  private async loadStaffRecipients(): Promise<string[]> {
    const staff = await this.users.find({
      where: {
        role: In([UserRole.Moderator, UserRole.Admin]),
        status: UserStatus.Active,
      },
      select: { id: true },
    });
    return staff.map((staffUser) => staffUser.id);
  }
}
