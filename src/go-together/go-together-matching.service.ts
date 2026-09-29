import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { Event, EventStatus } from '../events/entities/event.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Block } from '../social/entities/block.entity';
import { EventMatchConfig } from './entities/event-match-config.entity';
import {
  EntryStatus,
  EventMatchEntry,
} from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import {
  MatchFeedback,
  MeetAgainVerdict,
} from './entities/match-feedback.entity';
import { MatchTrainingRow } from './entities/match-training-row.entity';
import {
  GoTogetherEligibilityService,
  OPT_IN_CLOSE_MS,
} from './go-together-eligibility.service';
import {
  GoTogetherFormationService,
  PENDING_STATUSES,
} from './go-together-formation.service';
import { FEEDBACK_WINDOW_MS } from './go-together-group.service';
import { isGoTogetherLaunched } from './go-together-launch.guard';

/**
 * Postgres advisory-lock keys for the two Go together sweeps. Advisory locks
 * share one namespace across the database, so these must stay unique. Keys in
 * use elsewhere: `MIGRATION_LOCK_KEY` (481205733107400), the cinema sweep
 * (793640001), the identity mailbox reconciliation (793_640_002_000), and the
 * `hashtext(...)` transaction locks, which stay inside the 32-bit range. Both
 * keys here sit above that range.
 */
export const MATCHING_LOCK_KEY = 793_640_003_000;
export const RETENTION_LOCK_KEY = 793_640_003_001;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RECONCILE_LOOKBACK_MS = 12 * HOUR_MS;
const FEEDBACK_AFTER_END_MS = 12 * HOUR_MS;
const FEEDBACK_AFTER_START_MS = 24 * HOUR_MS;
const EVENT_RETENTION_MS = 90 * DAY_MS;
/**
 * How long after a gathering ends (or starts, when it has no end time) a tick
 * still loads its config by date. The "meet again?" prompt goes out at most
 * 24 hours after the gathering; the rest is catch-up room for ticks missed
 * during an outage or while Go together was held dark. The feedback close has
 * its own condition in `ACTIVE_MATCH_CONDITION`, so it runs whenever it is
 * due. Keep this well inside `EVENT_RETENTION_MS`.
 */
const ACTIVE_AFTER_END_MS = 14 * DAY_MS;
const PROFILE_RETENTION_MS = 365 * DAY_MS;

/**
 * The cutoff claim condition. `cutoff_at` is saved when the host configures
 * matching, so it is clamped against the event's current `start_at` into the
 * allowed range (7 days to 6 hours before the start).
 */
const EFFECTIVE_CUTOFF_REACHED = `EXISTS (
  SELECT 1 FROM "events" "scheduled_event"
  WHERE "scheduled_event"."id" = "event_match_configs"."event_id"
    AND LEAST(
      GREATEST("event_match_configs"."cutoff_at", "scheduled_event"."start_at" - interval '7 days'),
      "scheduled_event"."start_at" - interval '6 hours'
    ) <= :now
)`;

/**
 * The active-match filter. A config is loaded while its gathering is not over
 * or ended under `ACTIVE_AFTER_END_MS` ago. Whatever the date, it is also
 * loaded while its prompt went out and one of its groups still holds per-pair
 * scores: that feedback window is still open, so the close has to run once it
 * is due. The close nulls those scores, which keeps this set small.
 *
 * Every column is written as quoted snake_case with its quoted alias. TypeORM's
 * property-path rewrite (`config.eventId` to `"config"."event_id"`) stops at a
 * space, comma or bracket and runs on through a line break, so a path that
 * ends a line would reach Postgres unrewritten and fail every tick.
 */
export const ACTIVE_MATCH_CONDITION = `(
  COALESCE("event"."end_at", "event"."start_at") > :activeSince
  OR (
    "config"."feedback_prompted_at" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "event_match_groups" "open_group"
      WHERE "open_group"."event_id" = "config"."event_id"
        AND "open_group"."training_written_at" IS NULL
        AND "open_group"."pair_components" IS NOT NULL
    )
  )
)`;

/** The active-match join, in the same quoted snake_case form. */
export const ACTIVE_MATCH_JOIN = '"event"."id" = "config"."event_id"';

/** Entries the reconcile pass re-checks: everyone still taking part. */
const LIVE_STATUSES: EntryStatus[] = ['waiting', 'grouped', 'unmatched'];

type ScheduledEvent = Pick<
  Event,
  'id' | 'slug' | 'title' | 'status' | 'startAt' | 'endAt'
>;

const SCHEDULED_EVENT_FIELDS = {
  id: true,
  slug: true,
  title: true,
  status: true,
  startAt: true,
  endAt: true,
} as const;

/**
 * One gathering a tick may still act on: the claim state of its config and
 * the event fields the passes read. Loaded once per tick and shared by every
 * pass that used to query matched configs on its own.
 */
interface ActiveMatch {
  event: ScheduledEvent;
  enabled: boolean;
  matchedAt: Date | null;
  lateGroupAt: Date | null;
  feedbackPromptedAt: Date | null;
}

/** Raw row of the active-match query, one per config (snake_case aliases). */
interface ActiveMatchRow {
  event_id: string;
  enabled: boolean;
  matched_at: Date | null;
  late_group_at: Date | null;
  feedback_prompted_at: Date | null;
  slug: string;
  title: string;
  status: EventStatus;
  start_at: Date;
  end_at: Date | null;
}

/** Raw rows from a claim's RETURNING clause (snake_case database columns). */
interface ClaimedConfigRow {
  event_id: string;
}

type ConfigClaimColumn = 'lateGroupAt' | 'feedbackPromptedAt';

const CLAIM_NULL_GUARDS: Record<ConfigClaimColumn, string> = {
  lateGroupAt: 'late_group_at IS NULL',
  feedbackPromptedAt: 'feedback_prompted_at IS NULL',
};

function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function claimedEventIdsOf(raw: unknown): string[] {
  return (raw as ClaimedConfigRow[]).map((row) => row.event_id);
}

/** When the "meet again?" prompt goes out: 12 hours after the end, or 24
 *  hours after the start when the gathering has no end time. */
function feedbackDueAt(event: ScheduledEvent): Date {
  return event.endAt
    ? new Date(event.endAt.getTime() + FEEDBACK_AFTER_END_MS)
    : new Date(event.startAt.getTime() + FEEDBACK_AFTER_START_MS);
}

/**
 * The Go together scheduler. Every pass is claim-based (a conditional UPDATE
 * on a timestamp column) and every event is processed in its own try/catch,
 * like `EventRemindersService`. The advisory lock keeps two replicas from
 * running the passes at the same time; the claims keep a pass from running
 * twice for one event even if the lock were lost.
 */
@Injectable()
export class GoTogetherMatchingService {
  private readonly logger = new Logger(GoTogetherMatchingService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventMatchConfig)
    private readonly configs: Repository<EventMatchConfig>,
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(EventMatchGroup)
    private readonly groups: Repository<EventMatchGroup>,
    @InjectRepository(MatchFeedback)
    private readonly feedback: Repository<MatchFeedback>,
    @InjectRepository(MatchTrainingRow)
    private readonly trainingRows: Repository<MatchTrainingRow>,
    @InjectRepository(FriendMatchProfile)
    private readonly profiles: Repository<FriendMatchProfile>,
    @InjectRepository(Block) private readonly blocks: Repository<Block>,
    private readonly eligibility: GoTogetherEligibilityService,
    private readonly formation: GoTogetherFormationService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so an escaping rejection would
    // become an unhandledRejection. The next tick retries.
    try {
      await this.withLock(MATCHING_LOCK_KEY, () => this.runPasses(new Date()));
    } catch (error) {
      this.logger.error(`Go together tick failed: ${describeError(error)}`);
    }
  }

  @Cron('0 4 * * *')
  async retentionSweep(): Promise<void> {
    try {
      await this.withLock(RETENTION_LOCK_KEY, () =>
        this.deleteExpired(new Date()),
      );
    } catch (error) {
      this.logger.error(
        `Go together retention sweep failed: ${describeError(error)}`,
      );
    }
  }

  async runPasses(now: Date): Promise<void> {
    // One shared read per tick. When it fails there is nothing reliable to
    // act on, so the tick logs once and ends; the next tick retries.
    let activeMatches: ActiveMatch[];
    try {
      activeMatches = await this.loadActiveMatches(now);
    } catch (error) {
      this.logger.error(
        `Go together tick skipped, the active-match read failed: ${describeError(error)}`,
      );
      return;
    }
    // Reconcile is a safety pass: members who were banned, removed or are no
    // longer going leave their groups even while Go together is held dark
    // (PRD-422). Every other pass forms, prompts or writes training rows, so
    // those wait for the launch key.
    const passes: [string, () => Promise<void>][] = [
      ['reconcile', () => this.reconcile(now, activeMatches)],
    ];
    if (isGoTogetherLaunched()) {
      passes.push(
        ['cutoff', () => this.cutoffPass(now, activeMatches)],
        ['late joiners', () => this.lateJoinerPass(now, activeMatches)],
        ['late group', () => this.lateGroupPass(now, activeMatches)],
        ['feedback prompt', () => this.feedbackPromptPass(now, activeMatches)],
        ['feedback close', () => this.feedbackClosePass(now, activeMatches)],
      );
    }
    // Each pass is caught on its own, so one failure never skips the rest.
    for (const [passName, pass] of passes) {
      try {
        await pass();
      } catch (error) {
        this.logger.error(
          `Go together ${passName} pass failed: ${describeError(error)}`,
        );
      }
    }
  }

  private async withLock(
    lockKey: number,
    work: () => Promise<void>,
  ): Promise<void> {
    const lockRunner = this.dataSource.createQueryRunner();
    try {
      await lockRunner.connect();
      // `QueryRunner.query` is untyped, hence the assertion.
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [lockKey],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          'Go together sweep skipped: another replica holds the lock',
        );
        return;
      }
      try {
        await work();
      } finally {
        await lockRunner.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      }
    } finally {
      await lockRunner.release();
    }
  }

  // Reconcile: RSVP changes, host removals, bans, cancellations, suspensions
  // and restrictions emit no event today, so every live entry is re-checked.

  private async reconcile(
    now: Date,
    activeMatches: ActiveMatch[],
  ): Promise<void> {
    const lookbackStartMs = now.getTime() - RECONCILE_LOOKBACK_MS;
    const recentEvents = activeMatches
      .filter(
        (match) =>
          match.enabled && match.event.startAt.getTime() > lookbackStartMs,
      )
      .map((match) => match.event);
    for (const event of recentEvents) {
      try {
        await this.reconcileEvent(event, now);
      } catch (error) {
        this.logger.error(
          `Go together reconcile failed for event ${event.id}: ${describeError(error)}`,
        );
      }
    }
  }

  private async reconcileEvent(
    event: ScheduledEvent,
    now: Date,
  ): Promise<void> {
    if (event.status === EventStatus.Cancelled) {
      if (await this.hasLiveMatching(event.id)) {
        await this.formation.dissolveEventGroups(event.id);
      }
      return;
    }
    const liveEntries = await this.entries.find({
      where: { eventId: event.id, status: In(LIVE_STATUSES) },
    });
    if (liveEntries.length === 0) return;
    const removedUserIds = await this.withdrawIneligible(
      event,
      liveEntries,
      now,
    );
    await this.separateBlockedGroupmates(
      event.id,
      liveEntries.filter(
        (entry) =>
          entry.status === 'grouped' && !removedUserIds.has(entry.userId),
      ),
    );
  }

  /** Withdraws every live entry whose member can no longer take part and
   *  clears invites to friends who cannot. Returns the removed user ids. */
  private async withdrawIneligible(
    event: ScheduledEvent,
    liveEntries: EventMatchEntry[],
    now: Date,
  ): Promise<Set<string>> {
    // An invited friend has no entry until they accept, so their eligibility
    // is checked here as well.
    const invitedUserIds = liveEntries
      .filter((entry) => entry.pairStatus === 'pending')
      .map((entry) => entry.pairPartnerId)
      .filter((partnerId): partnerId is string => partnerId !== null);
    const blockers = await this.eligibility.memberBlockers(
      event.id,
      [...liveEntries.map((entry) => entry.userId), ...invitedUserIds],
      now,
    );
    const removedUserIds = new Set<string>();
    if (blockers.size === 0) return removedUserIds;

    for (const entry of liveEntries) {
      const blocker = blockers.get(entry.userId);
      if (!blocker) continue;
      try {
        if (entry.status === 'grouped') {
          await this.formation.removeMember(entry);
        } else {
          await this.withdrawPendingEntry(entry);
        }
        removedUserIds.add(entry.userId);
        this.logger.log(
          `Go together withdrew entry ${entry.id} of event ${event.id}: ${blocker}`,
        );
      } catch (error) {
        this.logger.error(
          `Go together could not withdraw entry ${entry.id}: ${describeError(error)}`,
        );
      }
    }

    const staleInviteEntryIds = liveEntries
      .filter(
        (entry) =>
          entry.pairStatus === 'pending' &&
          entry.pairPartnerId !== null &&
          blockers.has(entry.pairPartnerId) &&
          !removedUserIds.has(entry.userId),
      )
      .map((entry) => entry.id);
    if (staleInviteEntryIds.length > 0) {
      await this.entries.update(
        { id: In(staleInviteEntryIds), pairStatus: 'pending' },
        { pairStatus: 'none', pairPartnerId: null },
      );
    }
    return removedUserIds;
  }

  /**
   * Self-heal for a block that landed while a formation run was seating
   * people: the block listener only moves members who were already grouped
   * together, so a pair seated in one group afterwards is found here and the
   * blocker moves out, exactly as the listener would have done. One query per
   * event; `moveAfterBlock` re-reads both entries, so a pair already
   * separated (a mutual block, a second row) is a no-op.
   */
  private async separateBlockedGroupmates(
    eventId: string,
    groupedEntries: EventMatchEntry[],
  ): Promise<void> {
    const groupIdByUserId = new Map<string, string>();
    for (const entry of groupedEntries) {
      if (entry.groupId) groupIdByUserId.set(entry.userId, entry.groupId);
    }
    if (groupIdByUserId.size < 2) return;
    const seatedUserIds = [...groupIdByUserId.keys()];
    const blockRows = await this.blocks.find({
      where: {
        blockerId: In(seatedUserIds),
        blockedId: In(seatedUserIds),
      },
      select: { blockerId: true, blockedId: true },
    });
    for (const { blockerId, blockedId } of blockRows) {
      const sharedGroupId = groupIdByUserId.get(blockerId);
      if (!sharedGroupId || sharedGroupId !== groupIdByUserId.get(blockedId)) {
        continue;
      }
      try {
        const wasSeparated = await this.formation.moveAfterBlock(
          eventId,
          blockerId,
          blockedId,
        );
        if (wasSeparated) {
          this.logger.warn(
            `Go together separated a blocked pair seated together in group ${sharedGroupId}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Go together could not separate a blocked pair in group ${sharedGroupId}: ${describeError(error)}`,
        );
      }
    }
  }

  /** A cancelled gathering still holding a live entry or an open group. */
  private async hasLiveMatching(eventId: string): Promise<boolean> {
    const [liveEntryCount, openGroupCount] = await Promise.all([
      this.entries.count({
        where: { eventId, status: In(LIVE_STATUSES) },
      }),
      this.groups.count({ where: { eventId, dissolvedAt: IsNull() } }),
    ]);
    return liveEntryCount > 0 || openGroupCount > 0;
  }

  /** A member with no group seat leaves the pool; no chat is involved. The
   *  lens goes with the entry: it only served this gathering's matching. */
  private async withdrawPendingEntry(entry: EventMatchEntry): Promise<void> {
    await this.entries.update(
      { id: entry.id, status: In(PENDING_STATUSES) },
      {
        status: 'withdrawn',
        pairStatus: 'none',
        pairPartnerId: null,
        mergeOfferGroupId: null,
        lens: null,
        lensConsentedAt: null,
      },
    );
    if (entry.pairStatus === 'accepted' && entry.pairPartnerId) {
      await this.entries.update(
        {
          eventId: entry.eventId,
          userId: entry.pairPartnerId,
          pairPartnerId: entry.userId,
        },
        { pairStatus: 'none', pairPartnerId: null },
      );
    }
  }

  // Cutoff: the main formation run, once per gathering.

  private async cutoffPass(
    now: Date,
    activeMatches: ActiveMatch[],
  ): Promise<void> {
    const claim = await this.configs
      .createQueryBuilder()
      .update(EventMatchConfig)
      .set({ matchedAt: now })
      .where('enabled = true')
      .andWhere('matched_at IS NULL')
      // The effective cutoff: a gathering moved after its cutoff was saved
      // still forms between 7 days and 6 hours before its new start.
      .andWhere(EFFECTIVE_CUTOFF_REACHED, { now })
      .returning('event_id')
      .execute();
    const claimedEventIds = claimedEventIdsOf(claim.raw);
    if (claimedEventIds.length === 0) return;
    const eventsById = await this.loadEventsById(claimedEventIds);
    const releasedEventIds = new Set<string>();
    for (const eventId of claimedEventIds) {
      const event = eventsById.get(eventId);
      if (this.isUpcomingDraft(event, now)) {
        await this.releaseClaim(eventId, { matchedAt: null });
        releasedEventIds.add(eventId);
        continue;
      }
      if (!this.isUpcoming(event, now)) continue;
      try {
        const counts = await this.formation.formForEvent(eventId);
        this.logger.log(
          `Go together formed ${counts.groupsFormed} group(s) for event ${eventId}, ${counts.unmatched} unmatched`,
        );
      } catch (error) {
        this.logger.error(
          `Go together formation failed for event ${eventId}: ${describeError(error)}`,
        );
        await this.releaseClaim(eventId, { matchedAt: null });
        releasedEventIds.add(eventId);
      }
    }
    // The later passes of this tick read the shared list, so the claims this
    // pass kept show there as matched, as a fresh read would.
    const keptEventIds = new Set(
      claimedEventIds.filter((eventId) => !releasedEventIds.has(eventId)),
    );
    for (const match of activeMatches) {
      if (keptEventIds.has(match.event.id)) match.matchedAt = now;
    }
  }

  // Late joiners: members who opted in after the cutoff fill open seats.

  private async lateJoinerPass(
    now: Date,
    activeMatches: ActiveMatch[],
  ): Promise<void> {
    const optInClosesMs = now.getTime() + OPT_IN_CLOSE_MS;
    const openEvents = activeMatches
      .filter(
        (match) =>
          match.matchedAt !== null &&
          match.lateGroupAt === null &&
          match.event.status === EventStatus.Published &&
          match.event.startAt.getTime() > optInClosesMs,
      )
      .map((match) => match.event);
    if (openEvents.length === 0) return;
    const pendingRows = await this.entries.find({
      where: {
        eventId: In(openEvents.map((event) => event.id)),
        status: In(PENDING_STATUSES),
      },
      select: { eventId: true },
    });
    const eventIdsWithPending = new Set(pendingRows.map((row) => row.eventId));
    for (const event of openEvents) {
      if (!eventIdsWithPending.has(event.id)) continue;
      try {
        const placedCount = await this.formation.placeLateJoiners(event.id);
        if (placedCount > 0) {
          this.logger.log(
            `Go together placed ${placedCount} late joiner(s) for event ${event.id}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Go together late joiners failed for event ${event.id}: ${describeError(error)}`,
        );
      }
    }
  }

  // Late group: when opt-in closes, the last seats fill and whoever is left
  // gets one more chance at a group of their own.

  private async lateGroupPass(
    now: Date,
    activeMatches: ActiveMatch[],
  ): Promise<void> {
    const optInClosesMs = now.getTime() + OPT_IN_CLOSE_MS;
    const closingEvents = activeMatches
      .filter(
        (match) =>
          match.matchedAt !== null &&
          match.lateGroupAt === null &&
          match.event.startAt.getTime() <= optInClosesMs,
      )
      .map((match) => match.event);
    const claimedEventIds = await this.claimConfigs(
      'lateGroupAt',
      closingEvents.map((event) => event.id),
      now,
    );
    const eventsById = new Map(closingEvents.map((event) => [event.id, event]));
    for (const eventId of claimedEventIds) {
      const event = eventsById.get(eventId);
      if (this.isUpcomingDraft(event, now)) {
        await this.releaseClaim(eventId, { lateGroupAt: null });
        continue;
      }
      if (!this.isUpcoming(event, now)) continue;
      try {
        await this.formation.placeLateJoiners(eventId);
        await this.formation.formLateGroup(eventId);
      } catch (error) {
        this.logger.error(
          `Go together late group failed for event ${eventId}: ${describeError(error)}`,
        );
        await this.releaseClaim(eventId, { lateGroupAt: null });
      }
    }
  }

  // Feedback prompt: "meet again?" after the gathering, and the lens goes.

  private async feedbackPromptPass(
    now: Date,
    activeMatches: ActiveMatch[],
  ): Promise<void> {
    const dueEvents = activeMatches
      .filter(
        (match) =>
          match.matchedAt !== null &&
          match.feedbackPromptedAt === null &&
          match.event.startAt.getTime() <= now.getTime() &&
          feedbackDueAt(match.event).getTime() <= now.getTime(),
      )
      .map((match) => match.event);
    const claimedEventIds = await this.claimConfigs(
      'feedbackPromptedAt',
      dueEvents.map((event) => event.id),
      now,
    );
    const eventsById = new Map(dueEvents.map((event) => [event.id, event]));
    for (const eventId of claimedEventIds) {
      const event = eventsById.get(eventId);
      if (!event) continue;
      try {
        await this.promptFeedback(event);
      } catch (error) {
        this.logger.error(
          `Go together feedback prompt failed for event ${eventId}: ${describeError(error)}`,
        );
      }
    }
  }

  private async promptFeedback(event: ScheduledEvent): Promise<void> {
    try {
      if (event.status === EventStatus.Published) {
        await this.sendMeetAgainPrompts(event);
      }
    } finally {
      // Lens retention: the lens only served this gathering's formation.
      await this.entries.update(
        { eventId: event.id },
        { lens: null, lensConsentedAt: null },
      );
    }
  }

  private async sendMeetAgainPrompts(event: ScheduledEvent): Promise<void> {
    const groupedEntries = await this.entries.find({
      where: { eventId: event.id, status: 'grouped', groupId: Not(IsNull()) },
      select: { userId: true, groupId: true },
    });
    const memberIdsByGroupId = new Map<string, string[]>();
    for (const entry of groupedEntries) {
      if (!entry.groupId) continue;
      const memberIds = memberIdsByGroupId.get(entry.groupId) ?? [];
      memberIds.push(entry.userId);
      memberIdsByGroupId.set(entry.groupId, memberIds);
    }
    if (memberIdsByGroupId.size === 0) return;
    const openGroups = await this.groups.find({
      where: { id: In([...memberIdsByGroupId.keys()]), dissolvedAt: IsNull() },
      select: { id: true },
    });
    for (const group of openGroups) {
      try {
        await this.notifications.createForRecipients(
          memberIdsByGroupId.get(group.id) ?? [],
          NotificationType.GoTogetherMeetAgain,
          {
            eventId: event.id,
            eventSlug: event.slug,
            eventTitle: event.title,
            groupId: group.id,
          },
        );
      } catch (error) {
        this.logger.error(
          `Go together meet-again prompt failed for group ${group.id}: ${describeError(error)}`,
        );
      }
    }
  }

  // Feedback close: a week after the prompt, rated pairs become
  // de-identified training rows and the per-pair scores are dropped.

  private async feedbackClosePass(
    now: Date,
    activeMatches: ActiveMatch[],
  ): Promise<void> {
    const windowClosedBeforeMs = now.getTime() - FEEDBACK_WINDOW_MS;
    const closedEventIds = activeMatches
      .filter(
        (match) =>
          match.feedbackPromptedAt !== null &&
          match.feedbackPromptedAt.getTime() <= windowClosedBeforeMs,
      )
      .map((match) => match.event.id);
    if (closedEventIds.length === 0) return;
    const closedGroups = await this.groups.find({
      where: {
        eventId: In(closedEventIds),
        trainingWrittenAt: IsNull(),
        pairComponents: Not(IsNull()),
      },
    });
    for (const group of closedGroups) {
      try {
        await this.writeTrainingRows(group, now);
      } catch (error) {
        this.logger.error(
          `Go together training rows failed for group ${group.id}: ${describeError(error)}`,
        );
      }
    }
  }

  private async writeTrainingRows(
    group: EventMatchGroup,
    now: Date,
  ): Promise<void> {
    const claim = await this.groups
      .createQueryBuilder()
      .update(EventMatchGroup)
      .set({ trainingWrittenAt: now })
      .where('id = :groupId', { groupId: group.id })
      .andWhere('training_written_at IS NULL')
      .returning('id')
      .execute();
    if ((claim.raw as unknown[]).length === 0) return;
    try {
      const feedbackRows = await this.feedback.find({
        where: { groupId: group.id },
        select: { raterId: true, rateeId: true, verdict: true },
      });
      const verdictByDirection = new Map<string, MeetAgainVerdict>(
        feedbackRows.map((row) => [
          `${row.raterId}:${row.rateeId}`,
          row.verdict,
        ]),
      );
      const rows: MatchTrainingRow[] = [];
      for (const [key, components] of Object.entries(
        group.pairComponents ?? {},
      )) {
        // `pairKey` joins the two user ids with a colon.
        const [firstUserId, secondUserId] = key.split(':');
        const firstVerdict = verdictByDirection.get(
          `${firstUserId}:${secondUserId}`,
        );
        const secondVerdict = verdictByDirection.get(
          `${secondUserId}:${firstUserId}`,
        );
        if (!firstVerdict || !secondVerdict) continue;
        rows.push(
          this.trainingRows.create({
            scoringVersion: group.scoringVersion,
            components,
            mutualYes: firstVerdict === 'yes' && secondVerdict === 'yes',
          }),
        );
      }
      if (rows.length > 0) await this.trainingRows.save(rows);
    } catch (error) {
      await this.groups.update(group.id, { trainingWrittenAt: null });
      throw error;
    }
    await this.groups.update(group.id, { pairComponents: null });
  }

  // Retention: groups (and their feedback), entries and the host's config 90
  // days after the gathering, questionnaires 12 months after their last use,
  // and every lens once its gathering has ended. A deleted group leaves its
  // chat in place for the members; the chat's link to the group is nulled by
  // the foreign key. The retention sweep runs whether or not Go together is
  // launched, so data still expires while the feature is held dark.

  private async deleteExpired(now: Date): Promise<void> {
    const eventsBefore = new Date(now.getTime() - EVENT_RETENTION_MS);
    const expiredEventIds =
      'SELECT "id" FROM "events" WHERE "start_at" < :eventsBefore';
    const deletedGroups = await this.groups
      .createQueryBuilder()
      .delete()
      .from(EventMatchGroup)
      .where(`event_id IN (${expiredEventIds})`, { eventsBefore })
      .execute();
    const deletedEntries = await this.entries
      .createQueryBuilder()
      .delete()
      .from(EventMatchEntry)
      .where(`event_id IN (${expiredEventIds})`, { eventsBefore })
      .execute();
    // Last: nothing references a config, and with it gone no tick loads the
    // gathering again, so the active-match query stays the size of the
    // retention window.
    const deletedConfigs = await this.configs
      .createQueryBuilder()
      .delete()
      .from(EventMatchConfig)
      .where(`event_id IN (${expiredEventIds})`, { eventsBefore })
      .execute();
    // The feedback prompt nulls the lens for matched gatherings; this also
    // covers a gathering whose matching never ran (switched off before the
    // cutoff, or never claimed), so no lens outlives its gathering.
    const clearedLenses = await this.entries
      .createQueryBuilder()
      .update(EventMatchEntry)
      .set({ lens: null, lensConsentedAt: null })
      .where(
        'event_id IN (SELECT "id" FROM "events" WHERE COALESCE("end_at", "start_at") < :now)',
        { now },
      )
      .andWhere('"lens" IS NOT NULL')
      .execute();
    const deletedProfiles = await this.profiles
      .createQueryBuilder()
      .delete()
      .from(FriendMatchProfile)
      .where(
        'GREATEST("updated_at", COALESCE("last_used_at", "updated_at")) < :idleBefore',
        { idleBefore: new Date(now.getTime() - PROFILE_RETENTION_MS) },
      )
      .execute();
    this.logger.log(
      `Go together retention: ${deletedGroups.affected ?? 0} group(s), ` +
        `${deletedEntries.affected ?? 0} entr(ies), ` +
        `${deletedConfigs.affected ?? 0} config(s), ` +
        `${deletedProfiles.affected ?? 0} questionnaire(s) deleted, ` +
        `${clearedLenses.affected ?? 0} lens(es) cleared`,
    );
  }

  // Shared helpers.

  /**
   * Every config whose gathering can still need a pass (see
   * `ACTIVE_MATCH_CONDITION`). One query joined on the event's primary key;
   * retention deletes configs 90 days after the gathering, so the scan stays
   * bounded by that window plus the upcoming gatherings.
   */
  private async loadActiveMatches(now: Date): Promise<ActiveMatch[]> {
    const activeSince = new Date(now.getTime() - ACTIVE_AFTER_END_MS);
    const rows = await this.configs
      .createQueryBuilder('config')
      .innerJoin(Event, 'event', ACTIVE_MATCH_JOIN)
      .select('"config"."event_id"', 'event_id')
      .addSelect('"config"."enabled"', 'enabled')
      .addSelect('"config"."matched_at"', 'matched_at')
      .addSelect('"config"."late_group_at"', 'late_group_at')
      .addSelect('"config"."feedback_prompted_at"', 'feedback_prompted_at')
      .addSelect('"event"."slug"', 'slug')
      .addSelect('"event"."title"', 'title')
      .addSelect('"event"."status"', 'status')
      .addSelect('"event"."start_at"', 'start_at')
      .addSelect('"event"."end_at"', 'end_at')
      .where(ACTIVE_MATCH_CONDITION, { activeSince })
      .getRawMany<ActiveMatchRow>();
    return rows.map((row) => ({
      event: {
        id: row.event_id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        startAt: row.start_at,
        endAt: row.end_at,
      },
      enabled: row.enabled,
      matchedAt: row.matched_at,
      lateGroupAt: row.late_group_at,
      feedbackPromptedAt: row.feedback_prompted_at,
    }));
  }

  /** Stamps the claim column on the candidates still unclaimed and returns
   *  the event ids this statement took, so each runs at most once. */
  private async claimConfigs(
    column: ConfigClaimColumn,
    candidateEventIds: string[],
    now: Date,
  ): Promise<string[]> {
    if (candidateEventIds.length === 0) return [];
    const claimValues: Partial<Pick<EventMatchConfig, ConfigClaimColumn>> =
      column === 'lateGroupAt'
        ? { lateGroupAt: now }
        : { feedbackPromptedAt: now };
    const claim = await this.configs
      .createQueryBuilder()
      .update(EventMatchConfig)
      .set(claimValues)
      .where('event_id IN (:...eventIds)', { eventIds: candidateEventIds })
      .andWhere('matched_at IS NOT NULL')
      .andWhere(CLAIM_NULL_GUARDS[column])
      .returning('event_id')
      .execute();
    return claimedEventIdsOf(claim.raw);
  }

  /** Hands a failed event back to the next tick. */
  private async releaseClaim(
    eventId: string,
    release: Partial<Pick<EventMatchConfig, 'matchedAt' | 'lateGroupAt'>>,
  ): Promise<void> {
    try {
      await this.configs.update({ eventId }, release);
    } catch (error) {
      this.logger.error(
        `Go together could not release the claim on event ${eventId}: ${describeError(error)}`,
      );
    }
  }

  private async loadEventsById(
    eventIds: string[],
  ): Promise<Map<string, ScheduledEvent>> {
    const rows = await this.events.find({
      where: { id: In(eventIds) },
      select: SCHEDULED_EVENT_FIELDS,
    });
    return new Map(rows.map((event) => [event.id, event]));
  }

  /** An unpublished gathering that may still be republished: its claim is
   *  handed back so formation runs once it is live again. A cancelled or
   *  started gathering keeps its claim. */
  private isUpcomingDraft(
    event: ScheduledEvent | undefined,
    now: Date,
  ): boolean {
    return (
      event !== undefined &&
      event.status === EventStatus.Draft &&
      event.startAt.getTime() > now.getTime()
    );
  }

  private isUpcoming(
    event: ScheduledEvent | undefined,
    now: Date,
  ): event is ScheduledEvent {
    return (
      event !== undefined &&
      event.status === EventStatus.Published &&
      event.startAt.getTime() > now.getTime()
    );
  }
}
