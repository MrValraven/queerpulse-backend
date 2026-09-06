import {
  ADMIN_QUEUE_KEYS,
  ADMIN_QUEUE_REGISTRY,
  AdminQueueKey,
  AdminQueueMeta,
} from '../admin-queue-notifications/admin-queue.registry';
import { UserRole } from '../users/entities/user.entity';
import type { StaffRoleId } from '../users/staff-roles.registry';

/**
 * Shape the staff triage console renders, plus the pure math behind it — no DB
 * access, no Nest decorators — mirroring `../admin-overview/admin-overview-response.ts`
 * and `../admin-members/admin-members-response.ts`. The counting itself lives
 * in `admin-queues.service.ts`; everything that turns raw tallies into an
 * ordered, totalled answer lives here so it is directly unit-testable.
 *
 * WHY THIS EXISTS (PRD-282). Before it, no single screen said what was waiting:
 * the dashboard's triage block carried four counts, the console rail carried
 * five badges, and the other two dozen queues announced arrivals into the bell
 * and then went silent. A DSAR on a statutory 30-day clock only read as overdue
 * once somebody happened to open `/admin/dsar`, and an operator had to walk
 * roughly fifteen pages a day to be sure nothing had gone red.
 */

/**
 * The three queues that receive arrivals and are deliberately NOT in
 * `AdminQueueKey`.
 *
 * `admin-queue.registry.ts` explains why they are absent from it: each already
 * has a notification type of its own (`ReportFiled`,
 * `BanEvasionEscalationRaised`, `CommunityOwnerReviewRequested`) and a second
 * `admin_queue_item` row would double every arrival. That is a rule about
 * NOTIFICATIONS. It says nothing about whether an operator needs to see the
 * backlog, and the scan finding this module answers names ban-evasion
 * escalations specifically as work nobody can see. So the triage console counts
 * all three, from a small vocabulary of its own rather than by adding keys to
 * a registry that is not this module's to write.
 *
 * These values share the wire namespace with `AdminQueueKey`, so they are
 * append-only in exactly the same way and must never collide with one.
 */
export enum AdminExtraQueueKey {
  Reports = 'reports',
  BanEvasionEscalations = 'ban_evasion_escalations',
  CommunityOwnerReviewRequests = 'community_owner_review_requests',
}

/**
 * Who can work each of the three, in the same shape `ADMIN_QUEUE_REGISTRY`
 * uses, so one access predicate covers all thirty-one queues.
 *
 * Each tier below is read off the controller that actually serves the queue and
 * the frontend gate that decides whether the deep link opens, exactly as the
 * registry's own entries are:
 *
 *  - reports: `ModerationController` is `@Roles(Moderator, Admin)` and
 *    `/admin/moderation` heads `MOD_ACCESSIBLE_ADMIN_PATTERNS`.
 *  - ban-evasion escalations: `BanEvasionController` is
 *    `@Roles(Moderator, Admin)` at class level and `routes.adminBanEvasion` is
 *    in the same frontend list.
 *  - community owner review requests: Admin, with NO capability, even though
 *    the `communities` grant does open `/admin/communities`. The only action a
 *    row in this queue leads to is reassigning ownership, and
 *    `staff-roles.registry.ts` states plainly that freezing, archiving and
 *    reassigning ownership are moderation of last resort and stay Admin-only.
 *    A grant that cannot act on the queue does not get told its depth.
 */
export const ADMIN_EXTRA_QUEUE_REGISTRY: Record<
  AdminExtraQueueKey,
  AdminQueueMeta
> = {
  [AdminExtraQueueKey.Reports]: {
    route: '/admin/moderation',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminExtraQueueKey.BanEvasionEscalations]: {
    route: '/admin/ban-evasion',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminExtraQueueKey.CommunityOwnerReviewRequests]: {
    route: '/admin/communities',
    tier: UserRole.Admin,
    capabilities: [],
  },
};

/** Every queue the triage console covers: the registry's, plus the three. */
export type AdminTriageQueueKey = AdminQueueKey | AdminExtraQueueKey;

/**
 * The joined access map. Derived from `ADMIN_QUEUE_REGISTRY` rather than
 * restated, so a queue added to the registry tomorrow is covered here the same
 * day: a hand-curated list beside the taxonomy it mirrors is drift nobody can
 * see until the wrong person is paged or the right person is not.
 */
export const ADMIN_TRIAGE_QUEUE_REGISTRY: Record<
  AdminTriageQueueKey,
  AdminQueueMeta
> = {
  ...ADMIN_QUEUE_REGISTRY,
  ...ADMIN_EXTRA_QUEUE_REGISTRY,
};

/** Every triage queue, registry order first, then the three extras. */
export const ADMIN_TRIAGE_QUEUE_KEYS: readonly AdminTriageQueueKey[] = [
  ...ADMIN_QUEUE_KEYS,
  ...Object.values(AdminExtraQueueKey),
];

/**
 * Every additive grant that reaches at least one triage queue on its own.
 *
 * Derived, never hand-listed: this is what `@StaffRoles(...)` on the controller
 * is spread from, so a grant-holding member who is only a `member` by account
 * tier can still reach the endpoint and see their own queues. Hand-listing it
 * would silently lock out the next grant that gets a queue.
 */
export const ADMIN_TRIAGE_QUEUE_CAPABILITIES: readonly StaffRoleId[] = [
  ...new Set(
    Object.values(ADMIN_TRIAGE_QUEUE_REGISTRY).flatMap(
      (queueMeta) => queueMeta.capabilities,
    ),
  ),
];

/**
 * Whether this caller may work this queue, and therefore may learn its depth.
 *
 * This is `RolesOrStaffGuard`'s union rule applied to the RESPONSE BODY rather
 * than to the endpoint, and applying it to the body is the whole point. A
 * moderator can open `/admin/queues`; they must still not learn the DSAR
 * backlog, because they cannot open `/admin/dsar`. Narrowing only the endpoint
 * would have handed every moderator a summary of every admin-only register on
 * the platform, which is exactly the mistake this repo keeps a standing note
 * about.
 *
 * Admin short-circuits as a superset of every grant, matching the guard and
 * `AdminQueueNotificationsService.resolveRecipients`.
 */
export function canWorkQueue(
  queueMeta: AdminQueueMeta,
  callerRole: UserRole,
  callerCapabilities: ReadonlySet<StaffRoleId>,
): boolean {
  if (callerRole === UserRole.Admin) return true;
  if (
    queueMeta.tier === UserRole.Moderator &&
    callerRole === UserRole.Moderator
  ) {
    return true;
  }
  return queueMeta.capabilities.some((capability) =>
    callerCapabilities.has(capability),
  );
}

/** One queue as the service counted it, before any presentation. */
export interface AdminQueueTally {
  queue: AdminTriageQueueKey;
  /**
   * Rows still waiting on staff. NULL means the queue records no worked/
   * unworked state at all, so nothing can honestly say what is waiting in it —
   * see `commission_interests` in `admin-queue-counters.ts`.
   */
  waitingCount: number | null;
  /** Arrival time of the oldest waiting row, or null when nothing waits. */
  oldestWaitingAt: Date | null;
  /**
   * Waiting rows past their deadline. NULL means the queue has no deadline at
   * all, which is different from zero and is never rendered as "on time".
   */
  overdueCount: number | null;
}

/** One queue as the console renders it. */
export interface AdminQueueSummaryDTO {
  /**
   * An `AdminQueueKey` value or an `AdminExtraQueueKey` value. The same wire
   * vocabulary the bell's `payload.queue` uses, so the console can reuse the
   * frontend's existing queue label and route resolvers.
   */
  queue: string;
  /** The frontend path this queue is worked on. Straight from the registry. */
  route: string;
  /** See `AdminQueueTally.waitingCount`. */
  waitingCount: number | null;
  /** ISO instant the oldest waiting row arrived; null when nothing waits. */
  oldestWaitingAt: string | null;
  /** Whole hours the oldest waiting row has waited; null when nothing waits. */
  oldestWaitingHours: number | null;
  /** See `AdminQueueTally.overdueCount`. */
  overdueCount: number | null;
}

export interface AdminQueuesDTO {
  /** When this answer was computed. Every age in it is measured from here. */
  generatedAt: string;
  totals: {
    /** Rows waiting across every queue the caller can work. */
    waitingCount: number;
    /** Overdue rows across every queue the caller can work that has a clock. */
    overdueCount: number;
    /** How many queues have at least one row waiting. */
    queuesWithWorkCount: number;
    /** How many queues could not be counted at all (`waitingCount` null). */
    uncountableQueueCount: number;
  };
  /**
   * Only the queues this caller may work. An inaccessible queue is ABSENT
   * rather than present with nulls: a row of nulls would still disclose that
   * the queue exists and is being tracked, and would render as a broken tile.
   *
   * Ordered most urgent first — see `compareAdminQueueUrgency`.
   */
  queues: AdminQueueSummaryDTO[];
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whole hours between `oldestWaitingAt` and `now`, floored, never negative.
 *
 * Floored rather than rounded because this number is read as "it has been
 * waiting at least this long", and a clock that rounds 30 minutes up to an hour
 * overstates the platform's own lateness in the one place staff are meant to
 * trust it.
 */
export function hoursWaitingSince(
  oldestWaitingAt: Date | null,
  now: Date,
): number | null {
  if (!oldestWaitingAt) return null;
  const elapsedMs = now.getTime() - oldestWaitingAt.getTime();
  if (elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / HOUR_MS);
}

export function toAdminQueueSummaryDTO(
  tally: AdminQueueTally,
  route: string,
  now: Date,
): AdminQueueSummaryDTO {
  return {
    queue: tally.queue,
    route,
    waitingCount: tally.waitingCount,
    oldestWaitingAt: tally.oldestWaitingAt
      ? tally.oldestWaitingAt.toISOString()
      : null,
    oldestWaitingHours: hoursWaitingSince(tally.oldestWaitingAt, now),
    overdueCount: tally.overdueCount,
  };
}

/**
 * Most urgent first, and "urgent" is defined in the order an operator asks the
 * questions: is anything past a promised deadline, then what has been sitting
 * longest, then how much of it is there.
 *
 * A queue with no deadline never sorts above one that has breached a real
 * promise, however long its oldest row has waited: the deadline is the platform
 * having said a number out loud, and that is a different kind of late.
 *
 * The final tie-break is the queue key, so two empty queues never swap places
 * between two polls of the same unchanged data.
 */
export function compareAdminQueueUrgency(
  firstQueue: AdminQueueSummaryDTO,
  secondQueue: AdminQueueSummaryDTO,
): number {
  const firstOverdue = firstQueue.overdueCount ?? 0;
  const secondOverdue = secondQueue.overdueCount ?? 0;
  if (firstOverdue !== secondOverdue) return secondOverdue - firstOverdue;

  const firstHours = firstQueue.oldestWaitingHours ?? -1;
  const secondHours = secondQueue.oldestWaitingHours ?? -1;
  if (firstHours !== secondHours) return secondHours - firstHours;

  const firstWaiting = firstQueue.waitingCount ?? -1;
  const secondWaiting = secondQueue.waitingCount ?? -1;
  if (firstWaiting !== secondWaiting) return secondWaiting - firstWaiting;

  return firstQueue.queue.localeCompare(secondQueue.queue);
}

/** Orders the summaries and rolls them up into the console's header figures. */
export function summariseAdminQueues(
  summaries: AdminQueueSummaryDTO[],
  now: Date,
): AdminQueuesDTO {
  const orderedQueues = [...summaries].sort(compareAdminQueueUrgency);
  return {
    generatedAt: now.toISOString(),
    totals: {
      waitingCount: orderedQueues.reduce(
        (runningTotal, queue) => runningTotal + (queue.waitingCount ?? 0),
        0,
      ),
      overdueCount: orderedQueues.reduce(
        (runningTotal, queue) => runningTotal + (queue.overdueCount ?? 0),
        0,
      ),
      queuesWithWorkCount: orderedQueues.filter(
        (queue) => (queue.waitingCount ?? 0) > 0,
      ).length,
      uncountableQueueCount: orderedQueues.filter(
        (queue) => queue.waitingCount === null,
      ).length,
    },
    queues: orderedQueues,
  };
}
