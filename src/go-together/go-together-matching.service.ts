import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
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
    const passes: [string, () => Promise<void>][] = [
      ['reconcile', () => this.reconcile(now)],
      ['cutoff', () => this.cutoffPass(now)],
      ['late joiners', () => this.lateJoinerPass(now)],
      ['late group', () => this.lateGroupPass(now)],
      ['feedback prompt', () => this.feedbackPromptPass(now)],
      ['feedback close', () => this.feedbackClosePass(now)],
    ];
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

  private async reconcile(now: Date): Promise<void> {
    const enabledConfigs = await this.configs.find({
      where: { enabled: true },
      select: { eventId: true },
    });
    if (enabledConfigs.length === 0) return;
    const recentEvents = await this.events.find({
      where: {
        id: In(enabledConfigs.map((config) => config.eventId)),
        startAt: MoreThan(new Date(now.getTime() - RECONCILE_LOOKBACK_MS)),
      },
      select: SCHEDULED_EVENT_FIELDS,
    });
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

  private async cutoffPass(now: Date): Promise<void> {
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
    for (const eventId of claimedEventIds) {
      const event = eventsById.get(eventId);
      if (this.isUpcomingDraft(event, now)) {
        await this.releaseClaim(eventId, { matchedAt: null });
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
      }
    }
  }

  // Late joiners: members who opted in after the cutoff fill open seats.

  private async lateJoinerPass(now: Date): Promise<void> {
    const openEvents = await this.matchedEvents(
      { lateGroupAt: IsNull() },
      {
        status: EventStatus.Published,
        startAt: MoreThan(new Date(now.getTime() + OPT_IN_CLOSE_MS)),
      },
    );
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

  private async lateGroupPass(now: Date): Promise<void> {
    const closingEvents = await this.matchedEvents(
      { lateGroupAt: IsNull() },
      { startAt: LessThanOrEqual(new Date(now.getTime() + OPT_IN_CLOSE_MS)) },
    );
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

  private async feedbackPromptPass(now: Date): Promise<void> {
    const pastEvents = await this.matchedEvents(
      { feedbackPromptedAt: IsNull() },
      { startAt: LessThanOrEqual(now) },
    );
    const dueEvents = pastEvents.filter(
      (event) => feedbackDueAt(event).getTime() <= now.getTime(),
    );
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

  private async feedbackClosePass(now: Date): Promise<void> {
    const openGroups = await this.groups.find({
      where: { trainingWrittenAt: IsNull(), pairComponents: Not(IsNull()) },
      select: { id: true, eventId: true },
    });
    if (openGroups.length === 0) return;
    const closedConfigs = await this.configs.find({
      where: {
        eventId: In([...new Set(openGroups.map((group) => group.eventId))]),
        feedbackPromptedAt: LessThanOrEqual(
          new Date(now.getTime() - FEEDBACK_WINDOW_MS),
        ),
      },
      select: { eventId: true },
    });
    const closedEventIds = new Set(
      closedConfigs.map((config) => config.eventId),
    );
    const closedGroupIds = openGroups
      .filter((group) => closedEventIds.has(group.eventId))
      .map((group) => group.id);
    if (closedGroupIds.length === 0) return;
    const closedGroups = await this.groups.find({
      where: { id: In(closedGroupIds) },
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

  // Retention: entries, groups (and their feedback) 90 days after the
  // gathering, questionnaires 12 months after their last use, and every lens
  // once its gathering has ended. A deleted group leaves its chat in place
  // for the members; the chat's link to the group is nulled by the foreign
  // key.

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
        `${deletedProfiles.affected ?? 0} questionnaire(s) deleted, ` +
        `${clearedLenses.affected ?? 0} lens(es) cleared`,
    );
  }

  // Shared helpers.

  /** Events of matched configs, narrowed by config and event conditions. */
  private async matchedEvents(
    configWhere: FindOptionsWhere<EventMatchConfig>,
    eventWhere: FindOptionsWhere<Event>,
  ): Promise<ScheduledEvent[]> {
    const matchedConfigs = await this.configs.find({
      where: { ...configWhere, matchedAt: Not(IsNull()) },
      select: { eventId: true },
    });
    if (matchedConfigs.length === 0) return [];
    return this.events.find({
      where: {
        ...eventWhere,
        id: In(matchedConfigs.map((config) => config.eventId)),
      },
      select: SCHEDULED_EVENT_FIELDS,
    });
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
