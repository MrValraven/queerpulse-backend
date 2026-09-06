import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { UserRole } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { isStaffRoleId, StaffRoleId } from '../users/staff-roles.registry';
import {
  ADMIN_TRIAGE_QUEUE_COUNTERS,
  QUEUE_NOW_PARAMETER,
  QueueColumnRef,
} from './admin-queue-counters';
import {
  ADMIN_TRIAGE_QUEUE_KEYS,
  ADMIN_TRIAGE_QUEUE_REGISTRY,
  AdminQueuesDTO,
  AdminQueueSummaryDTO,
  AdminQueueTally,
  AdminTriageQueueKey,
  canWorkQueue,
  summariseAdminQueues,
  toAdminQueueSummaryDTO,
} from './admin-queues-response';

/** The alias every counting query runs under. */
const QUEUE_ROW_ALIAS = 'queue_row';

/**
 * How many queue counts may be in flight at once.
 *
 * `DATABASE_POOL_MAX` defaults to 10 on a single-replica backend and
 * `DATABASE_CONNECTION_TIMEOUT_MS` gives an unrelated request 10 seconds to get
 * a slot, so an uncapped fan-out of thirty aggregates would starve every other
 * request sharing that pool for as long as it ran. Six leaves headroom while
 * still finishing an admin's full sweep in roughly five passes.
 *
 * A SLIDING POOL rather than waves of `Promise.all`: waves cost their slowest
 * member, and the aggregate over `reports` is not the same size as the one over
 * `changemaker_nomination`.
 */
const MAX_CONCURRENT_QUEUE_COUNTS = 6;

/** Raw shape one counting query returns. */
interface QueueTallyRow {
  waiting_count: number | string | null;
  oldest_waiting_at: Date | string | null;
  overdue_count?: number | string | null;
}

/**
 * The read model behind `GET /admin/queues`: what is waiting, everywhere, for
 * the person asking (PRD-282).
 *
 * ## One query per table, never one per row
 *
 * Each queue costs exactly one aggregate that returns its depth, its oldest
 * arrival and its overdue count together — `COUNT(*)`, `MIN(...)` and a
 * `COUNT(*) FILTER (WHERE deadline < now)` in a single SELECT over the same
 * filtered set. No `In([...])` list is built anywhere here, so the
 * bind-parameter ceiling `AdminOverviewService.loadReportResolutions` documents
 * cannot be reached. `intake_submissions` backs two queues and is read twice,
 * once per predicate, because the two predicates partition the table and
 * merging them into one grouped query would trade a round trip for a `GROUP BY`
 * whose result still has to be split apart in TypeScript.
 *
 * ## Access filtering happens to the BODY
 *
 * The accessible set is computed BEFORE the fan-out, so a queue the caller
 * cannot work costs no query and appears nowhere in the answer. That ordering
 * is not only about privacy, it is most of the cost: a full request is 30
 * round trips for an admin (31 queues, one of them uncountable, and no grant
 * lookup because Admin is a superset of every grant), 12 for a moderator (the
 * grant lookup plus 11 moderator-tier queues), and 3 for a plain member
 * holding a single grant such as `editorial`.
 */
@Injectable()
export class AdminQueuesService {
  private readonly logger = new Logger(AdminQueuesService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UserStaffRole)
    private readonly staffGrants: Repository<UserStaffRole>,
  ) {}

  async getQueues(caller: CurrentUserData): Promise<AdminQueuesDTO> {
    // One instant for the whole answer. Two queues measured against clocks a
    // few milliseconds apart could report a total that disagrees with its own
    // rows, which is the one thing a triage console cannot afford.
    const now = new Date();
    // The account tier as `RolesOrStaffGuard` reads it: the JWT carries `role`
    // as a plain string, and every tier comparison in this repo narrows it the
    // same way rather than comparing a string to an enum member.
    const callerRole = caller.role as UserRole;
    const callerCapabilities = await this.loadCallerCapabilities(caller);

    const accessibleQueueKeys = ADMIN_TRIAGE_QUEUE_KEYS.filter((queueKey) =>
      canWorkQueue(
        ADMIN_TRIAGE_QUEUE_REGISTRY[queueKey],
        callerRole,
        callerCapabilities,
      ),
    );

    // Thunks, not started promises: an already-started query has claimed its
    // pool connection before the sliding pool ever sees it.
    //
    // Caught INSIDE the thunk, deliberately. A rejection would otherwise stop
    // the pool and fail the whole request, so one locked or missing table would
    // blank a console whose entire job is to show the other thirty queues. The
    // failed queue comes back as "cannot tell" (all nulls) rather than as a
    // zero, which is the one answer that would wrongly let an operator stop
    // looking, and the reason is logged.
    const tallyThunks = accessibleQueueKeys.map(
      (queueKey) => (): Promise<AdminQueueTally> =>
        this.tallyQueue(queueKey, now).catch((error: unknown) => {
          this.logger.warn(
            `admin queue tally failed for ${queueKey}: ${String(error)}`,
          );
          return {
            queue: queueKey,
            waitingCount: null,
            oldestWaitingAt: null,
            overdueCount: null,
          };
        }),
    );
    const tallies = await runWithConcurrency(
      tallyThunks,
      MAX_CONCURRENT_QUEUE_COUNTS,
    );

    const summaries: AdminQueueSummaryDTO[] = tallies.map((tally) =>
      toAdminQueueSummaryDTO(
        tally,
        ADMIN_TRIAGE_QUEUE_REGISTRY[tally.queue].route,
        now,
      ),
    );
    return summariseAdminQueues(summaries, now);
  }

  /**
   * The caller's additive grants.
   *
   * Skipped entirely for an admin: `RolesOrStaffGuard` treats Admin as a
   * superset of every grant without a query, and `canWorkQueue` says the same,
   * so looking the rows up would be a round trip whose answer is never read.
   */
  private async loadCallerCapabilities(
    caller: CurrentUserData,
  ): Promise<ReadonlySet<StaffRoleId>> {
    if ((caller.role as UserRole) === UserRole.Admin) {
      return new Set<StaffRoleId>();
    }
    const grants = await this.staffGrants.find({
      where: { userId: caller.userId },
      select: { role: true },
    });
    return new Set(
      grants
        .map((grant) => grant.role)
        .filter((role): role is StaffRoleId => isStaffRoleId(role)),
    );
  }

  /**
   * One queue's depth, oldest arrival and overdue count, in one round trip.
   *
   * A queue with no counter comes back as all-nulls rather than as a zero: "we
   * cannot tell" and "there is nothing waiting" are different answers, and only
   * one of them means an operator can stop looking.
   */
  private async tallyQueue(
    queue: AdminTriageQueueKey,
    now: Date,
  ): Promise<AdminQueueTally> {
    const counter = ADMIN_TRIAGE_QUEUE_COUNTERS[queue];
    if (!counter) {
      return {
        queue,
        waitingCount: null,
        oldestWaitingAt: null,
        overdueCount: null,
      };
    }

    const repository = this.dataSource.getRepository(counter.entity);
    const column = this.buildColumnRef(repository, queue);
    const waiting = counter.buildWaitingWhere(column);

    const queryBuilder = repository
      .createQueryBuilder(QUEUE_ROW_ALIAS)
      // `::int` because node-pg hands `bigint` back as a string, and this
      // number is summed into a total on the way out.
      .select('COUNT(*)::int', 'waiting_count')
      .addSelect(
        `MIN(${column(counter.waitingSinceProperty)})`,
        'oldest_waiting_at',
      )
      .where(waiting.sql, {
        ...waiting.parameters,
        [QUEUE_NOW_PARAMETER]: now,
      });

    if (counter.buildDeadline) {
      const deadline = counter.buildDeadline(column);
      queryBuilder
        // Computed over the same filtered set as the count above, so overdue is
        // always a subset of waiting. A row whose deadline expression is NULL
        // (no clock on that particular row) fails the comparison and is not
        // counted, which is what "has missed no date" should do.
        .addSelect(
          `COUNT(*) FILTER (WHERE (${deadline.sql}) < :${QUEUE_NOW_PARAMETER})::int`,
          'overdue_count',
        )
        .setParameters(deadline.parameters);
    }

    const row = await queryBuilder.getRawOne<QueueTallyRow>();
    return {
      queue,
      waitingCount: toCount(row?.waiting_count) ?? 0,
      oldestWaitingAt: toDate(row?.oldest_waiting_at),
      overdueCount: counter.buildDeadline
        ? (toCount(row?.overdue_count) ?? 0)
        : null,
    };
  }

  /**
   * Resolves an entity property to its quoted, alias-qualified physical column.
   *
   * From entity METADATA rather than from a snake_case string typed into the
   * counter table: `SnakeNamingStrategy` owns that mapping, and a hand-written
   * second copy of it would count the wrong column the day a property is
   * renamed. An unknown property throws here rather than producing SQL that
   * fails somewhere less legible.
   */
  private buildColumnRef(
    repository: Repository<ObjectLiteral>,
    queue: AdminTriageQueueKey,
  ): QueueColumnRef<ObjectLiteral> {
    const escape = (identifier: string): string =>
      this.dataSource.driver.escape(identifier);
    return (property: string): string => {
      const columnMetadata =
        repository.metadata.findColumnWithPropertyPath(property);
      if (!columnMetadata) {
        throw new Error(
          `Queue "${queue}" counts a property "${property}" that ` +
            `${repository.metadata.name} does not have.`,
        );
      }
      return `${escape(QUEUE_ROW_ALIAS)}.${escape(columnMetadata.databaseName)}`;
    };
  }
}

/** `::int` should already have done this; the guard is for a driver that did not. */
function toCount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
