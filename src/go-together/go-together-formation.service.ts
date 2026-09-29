import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { GroupsService } from '../messaging/groups.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EventMatchConfig } from './entities/event-match-config.entity';
import {
  EntryStatus,
  EventMatchEntry,
} from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import {
  buildPairComponents,
  groupMinimumAffinity,
  groupUnitLists,
  hasGatheringStarted,
  isGatheringUpcoming,
  isPastBlockMoveGrace,
  orderHardestFirst,
  personIndexesOf,
  planPlacements,
  unitEntries,
  unitIndexesWhere,
  unplacedUnitIndexes,
} from './go-together-formation.helpers';
import {
  confirmChanged,
  guardedMoveIntoGroup,
  guardedMoveIntoOpenGroup,
} from './go-together-formation.writes';
import { formGroups, seedFrom } from './go-together-grouping';
import { GoTogetherHouseService } from './go-together-house.service';
import { isGoTogetherLaunched } from './go-together-launch.guard';
import { GoTogetherPoolService, MatchPool } from './go-together-pool.service';
import { buildGroupReasons, groupBand } from './go-together-reasons';
import { MIN_AFFINITY, SCORING_VERSION } from './go-together-scoring';

/** Late joiners, merges and moves only fill groups below this size. */
export const LATE_JOIN_MAX_SIZE = 5;
export const PENDING_STATUSES: EntryStatus[] = ['waiting', 'unmatched'];
export const MERGE_EXPIRED_CODE = 'GO_TOGETHER_MERGE_EXPIRED';

const PLACEMENT_LIMITS = {
  maxSize: LATE_JOIN_MAX_SIZE,
  minAffinity: MIN_AFFINITY,
} as const;

type EventSummary = Pick<Event, 'id' | 'slug' | 'title' | 'startAt'>;

/** What a member's leave ended: their place in the group, or only their
 *  seat in its chat (from the gathering's start onward). */
export type GoTogetherLeaveScope = 'group' | 'chat';

export interface FormationCounts {
  groupsFormed: number;
  unmatched: number;
}

interface PlacementPool {
  pool: MatchPool;
  /** Unit indexes per target group, aligned with the target groups. */
  groupLists: number[][];
  /** Units made only of the candidates being placed. */
  candidateUnits: number[];
}

interface PlacementPoolOptions {
  /** Pending entries kept in the pool answerless when their questionnaire
   *  is gone (`GoTogetherPoolService.buildPool`). */
  keepAnswerlessEntryIds?: ReadonlySet<string>;
}

/**
 * A refusal from `GroupsService.dissolveMatchedGroup` that a retry cannot
 * change: the chat is missing or is no matched group (400 or 404), or the
 * house has no owner seat in it (403).
 */
function isPermanentChatRefusal(error: unknown): boolean {
  return (
    error instanceof BadRequestException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  );
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

/**
 * Turns an event's opt-ins into groups and keeps those groups whole as people
 * come and go. Every read and the scoring go through `GoTogetherPoolService`;
 * the solver itself is pure. Each group gets a matched chat owned by the house
 * account. A failed chat call is logged and never undoes a formed group, so a
 * group can exist with `conversationId: null`.
 */
@Injectable()
export class GoTogetherFormationService {
  private readonly logger = new Logger(GoTogetherFormationService.name);

  constructor(
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(EventMatchGroup)
    private readonly groups: Repository<EventMatchGroup>,
    @InjectRepository(EventMatchConfig)
    private readonly configs: Repository<EventMatchConfig>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(ConversationParticipant)
    private readonly chatSeats: Repository<ConversationParticipant>,
    private readonly pool: GoTogetherPoolService,
    private readonly groupsService: GroupsService,
    private readonly house: GoTogetherHouseService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The cutoff run: groups every waiting member it can, anchors included. */
  async formForEvent(eventId: string): Promise<FormationCounts> {
    const loaded = await this.loadEventAndConfig(eventId);
    if (!loaded) return { groupsFormed: 0, unmatched: 0 };
    const { event, config } = loaded;
    const seedLabel = await this.nextSeedLabel(config);
    const waiting = await this.entries.find({
      where: { eventId, status: 'waiting' },
    });
    const { pool, skippedEntryIds } = await this.pool.buildPool(waiting, {
      includeAnchors: true,
    });
    if (skippedEntryIds.length > 0) {
      this.logger.warn(
        `Go together left ${skippedEntryIds.length} entries of ${eventId} out: no questionnaire`,
      );
    }
    const { groupsFormed, unplaced } = await this.solveAndPersist(
      event,
      config,
      pool,
      seedLabel,
    );
    await this.markUnmatched(event, unplaced, false);
    return { groupsFormed, unmatched: unplaced.length };
  }

  /**
   * Seats pending members into existing groups below `LATE_JOIN_MAX_SIZE`,
   * hardest to place first. Returns how many people were placed.
   */
  async placeLateJoiners(eventId: string): Promise<number> {
    const pending = await this.entries.find({
      where: { eventId, status: In(PENDING_STATUSES) },
    });
    if (pending.length === 0) return 0;
    const activeGroups = await this.activeGroupsOf(eventId);
    const event = await this.loadEvent(eventId);
    if (activeGroups.length === 0 || !event) return 0;
    const placed = await this.seatCandidates(
      event,
      pending,
      activeGroups,
      PENDING_STATUSES,
    );
    return placed.length;
  }

  /**
   * The last pass before the gathering: forms new groups from whoever is
   * still pending, then sends everyone left the final "no group this time".
   */
  async formLateGroup(eventId: string): Promise<FormationCounts> {
    const loaded = await this.loadEventAndConfig(eventId);
    if (!loaded) return { groupsFormed: 0, unmatched: 0 };
    const { event, config } = loaded;
    const pending = await this.entries.find({
      where: { eventId, status: In(PENDING_STATUSES) },
    });
    if (pending.length === 0) return { groupsFormed: 0, unmatched: 0 };
    const { pool, skippedEntryIds } = await this.pool.buildPool(pending, {
      includeAnchors: false,
    });
    let groupsFormed = 0;
    let remaining = pool.members.map((member) => member.entry);
    if (pool.members.length >= 3) {
      const seedLabel = await this.nextSeedLabel(config);
      const outcome = await this.solveAndPersist(
        event,
        config,
        pool,
        seedLabel,
      );
      groupsFormed = outcome.groupsFormed;
      remaining = [...outcome.unplaced, ...outcome.returnedToWaiting];
    }
    const skippedIds = new Set(skippedEntryIds);
    const left = [
      ...remaining,
      ...pending.filter((entry) => skippedIds.has(entry.id)),
    ];
    await this.markUnmatched(event, left, true);
    return { groupsFormed, unmatched: left.length };
  }

  /**
   * PRD-418: the one rule for a member leaving their group, shared by the
   * group sheet's Leave and the chat-leave listener (spec 3.6) so the two
   * keep one behaviour. Before the gathering starts, leaving takes the
   * member out of Go together for it (`removeMember`). From the start
   * onward only the chat seat ends: the entry stays `grouped`, so the member
   * stays on the meet-again page for the others and keeps their own reveal
   * and feedback. A member with no active seat in the chat (already left,
   * or never seated) is left alone, so a repeat leave is a quiet no-op.
   */
  async leaveGroup(
    entry: EventMatchEntry,
    now: Date = new Date(),
  ): Promise<GoTogetherLeaveScope> {
    const gathering = await this.loadEvent(entry.eventId);
    if (!hasGatheringStarted(gathering, now)) {
      await this.removeMember(entry);
      return 'group';
    }
    const group = entry.groupId
      ? await this.groups.findOne({ where: { id: entry.groupId } })
      : null;
    if (
      group?.conversationId &&
      !(await this.hasLeftChat(group.conversationId, entry.userId))
    ) {
      await this.leaveChat(group.conversationId, entry.userId);
    }
    return 'chat';
  }

  /** Whether the member holds no active seat in the group's chat: they left
   *  it, or were never seated in it (a failed chat call). */
  async hasLeftChat(conversationId: string, userId: string): Promise<boolean> {
    const hasActiveSeat = await this.chatSeats.exists({
      where: { conversationId, userId, leftAt: IsNull() },
    });
    return !hasActiveSeat;
  }

  /**
   * A member leaves Go together for this gathering: out of the chat, entry
   * withdrawn (its lens goes too, it has no further purpose), an accepted
   * partner turned solo (the partner keeps their seat), then the group they
   * left is offered a merge if it got small.
   */
  async removeMember(entry: EventMatchEntry): Promise<void> {
    const group = entry.groupId
      ? await this.groups.findOne({ where: { id: entry.groupId } })
      : null;
    if (group?.conversationId) {
      await this.leaveChat(group.conversationId, entry.userId);
    }
    await this.entries.update(
      { id: entry.id },
      {
        status: 'withdrawn',
        groupId: null,
        mergeOfferGroupId: null,
        pairStatus: 'none',
        pairPartnerId: null,
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
    if (group) await this.offerMergeIfSmall(group);
  }

  /**
   * Moves the member (and an accepted partner in the same group) into the
   * group they were offered, after checking it still fits them. The seat
   * count and the move are one locked write (`guardedMoveIntoOpenGroup`), so
   * a concurrent accept or late-joiner pass can never take the group past
   * `LATE_JOIN_MAX_SIZE` (ENG-432). The old chat is left only once the move
   * has landed. Throws 409 `GO_TOGETHER_MERGE_EXPIRED` and clears the offer
   * when nobody could move. The passed entry object is left as it was, so a
   * caller can still read `mergeOfferGroupId` from it afterwards.
   */
  async acceptMerge(entry: EventMatchEntry): Promise<void> {
    const targetGroupId = entry.mergeOfferGroupId;
    if (!targetGroupId) throw new NotFoundException('No merge offer to accept');
    const moving = await this.movingUnit(entry, null);
    const targetGroup = await this.groups.findOne({
      where: {
        id: targetGroupId,
        eventId: entry.eventId,
        dissolvedAt: IsNull(),
      },
    });
    const oldGroup = entry.groupId
      ? await this.groups.findOne({ where: { id: entry.groupId } })
      : null;
    const isStillOpen =
      targetGroup !== null && (await this.fitsWhole(moving, targetGroup));
    const moved =
      targetGroup && isStillOpen
        ? await this.moveIntoGroup(
            targetGroup,
            moving,
            ['grouped'],
            oldGroup?.conversationId ?? null,
          )
        : [];
    if (moved.length === 0) {
      await this.entries.update(
        { id: In(moving.map((member) => member.id)) },
        { mergeOfferGroupId: null },
      );
      throw new ConflictException({
        statusCode: 409,
        message: 'That group is no longer open',
        code: MERGE_EXPIRED_CODE,
      });
    }
    if (oldGroup) {
      const leftBehind = await this.entries.count({
        where: { groupId: oldGroup.id, status: 'grouped' },
      });
      if (leftBehind === 0) await this.dissolveGroup(oldGroup);
    }
  }

  /**
   * After a block between two members of one group, the blocker moves out.
   * Before the gathering starts, an accepted partner (unless the partner is
   * the blocked member) moves out together with the blocker: only the
   * event's other groups are candidates, so the pair never lands back
   * beside the blocked member, and an unplaced pair becomes `unmatched` for
   * the late-joiner pass to retry. The block row also makes the blocked
   * pair infeasible in every later pool.
   *
   * Once the gathering has started, only the blocker leaves: they go
   * straight to `unmatched` rather than being reseated into another
   * group's chat, since nobody is pulled into a new chat after the start.
   * An accepted partner who blocked nobody stays grouped in the same chat;
   * the pair link between them and the blocker is simply cleared.
   *
   * A block more than `BLOCK_MOVE_GRACE_MS` after the start moves nobody.
   *
   * Safe to run twice for one block, even at the same time: the group route
   * awaits it and the `MEMBER_BLOCKED` listener runs it too. Before any chat
   * or seat work, guarded writes (`claimOutOfGroup`) take the moving unit
   * out of the shared group to `unmatched`, the blocker first. Only the run
   * that took the blocker goes on, so the old chat is left once per member,
   * the merge offer goes out once, and the other run returns false having
   * sent nothing. Before the start, the claimed members are then seated from
   * `unmatched` into another group; whoever does not fit stays `unmatched`.
   * The seat plan keeps every claimed member in the pool, answerless when
   * their questionnaire is gone (they deleted it while seated), so the pair
   * stays one unit and either moves whole or stays `unmatched` whole
   * (spec 5.3), and such a blocker is still reseated where a group has room
   * (spec 3.6). A failed seat is logged: the claimed members stay
   * `unmatched` for the late-joiner pass, and the old group still gets its
   * one merge offer from this run.
   *
   * While Go together is held dark (PRD-422) the claim still runs, so the
   * blocker leaves the shared group and its chat, but nobody is reseated and
   * no merge offer goes out: the group routes those would lead to answer 404
   * until launch. The claimed members stay `unmatched`.
   *
   * Returns whether this run separated the pair, so a caller only logs
   * when something happened.
   */
  async moveAfterBlock(
    eventId: string,
    blockerUserId: string,
    blockedUserId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const pairEntries = await this.entries.find({
      where: { eventId, userId: In([blockerUserId, blockedUserId]) },
    });
    const blockerEntry = pairEntries.find(
      (entry) => entry.userId === blockerUserId,
    );
    const blockedEntry = pairEntries.find(
      (entry) => entry.userId === blockedUserId,
    );
    const sharedGroupId =
      blockerEntry?.status === 'grouped' &&
      blockedEntry?.status === 'grouped' &&
      blockerEntry.groupId === blockedEntry.groupId
        ? blockerEntry.groupId
        : null;
    if (!sharedGroupId || !blockerEntry || !blockedEntry) return false;
    const oldGroup = await this.groups.findOne({
      where: { id: sharedGroupId },
    });
    if (!oldGroup || oldGroup.dissolvedAt) return false;
    const event = await this.loadEvent(eventId);
    if (isPastBlockMoveGrace(event, now)) return false;
    if (blockerEntry.pairPartnerId === blockedUserId) {
      await this.entries.update(
        { id: In([blockerEntry.id, blockedEntry.id]) },
        { pairStatus: 'none', pairPartnerId: null },
      );
    }

    if (!isGatheringUpcoming(event, now)) {
      const claimed = await this.claimOutOfGroup([blockerEntry], oldGroup.id);
      if (claimed.length === 0) return false;
      const uninvolvedPartnerId =
        blockerEntry.pairStatus === 'accepted' &&
        blockerEntry.pairPartnerId !== null &&
        blockerEntry.pairPartnerId !== blockedUserId
          ? blockerEntry.pairPartnerId
          : null;
      if (uninvolvedPartnerId) {
        await this.entries.update(
          { id: In([blockerEntry.id]) },
          { pairStatus: 'none', pairPartnerId: null },
        );
        await this.entries.update(
          {
            eventId,
            userId: uninvolvedPartnerId,
            pairPartnerId: blockerUserId,
          },
          { pairStatus: 'none', pairPartnerId: null },
        );
      }
      if (oldGroup.conversationId) {
        await this.leaveChat(oldGroup.conversationId, blockerUserId);
      }
      await this.offerMergeIfSmall(oldGroup);
      return true;
    }

    const moving = await this.movingUnit(blockerEntry, blockedUserId);
    const claimed = await this.claimOutOfGroup(moving, oldGroup.id);
    if (claimed.length === 0) return false;
    if (oldGroup.conversationId) {
      for (const member of claimed) {
        await this.leaveChat(oldGroup.conversationId, member.userId);
      }
    }
    try {
      const otherGroups = isGoTogetherLaunched()
        ? (await this.activeGroupsOf(eventId)).filter(
            (group) => group.id !== oldGroup.id,
          )
        : [];
      if (otherGroups.length > 0) {
        await this.seatCandidates(event, claimed, otherGroups, ['unmatched'], {
          keepAnswerlessEntryIds: new Set(claimed.map((member) => member.id)),
        });
      }
    } catch (error) {
      this.logger.error(
        `Go together could not reseat the members it took out of group ${oldGroup.id}; they stay unmatched for the late-joiner pass: ${describeError(error)}`,
      );
    }
    await this.offerMergeIfSmall(oldGroup);
    return true;
  }

  /**
   * Takes `members` out of `groupId` to `unmatched` with one guarded
   * single-row write each, the first member (the blocker) first. Each write
   * only matches a row still seated in that group, and Postgres re-checks
   * the WHERE of a waiting UPDATE against the committed row, so of two runs
   * racing for the same block exactly one takes the blocker; the other gets
   * nothing back and stops there. Returns the entries this run changed, as
   * they now are, ready to be seated from `unmatched`.
   */
  private async claimOutOfGroup(
    members: EventMatchEntry[],
    groupId: string,
  ): Promise<EventMatchEntry[]> {
    const claimed: EventMatchEntry[] = [];
    for (const member of members) {
      const result = await this.entries.update(
        { id: member.id, status: 'grouped', groupId },
        { status: 'unmatched', groupId: null, mergeOfferGroupId: null },
      );
      if ((result.affected ?? 0) > 0) {
        claimed.push({
          ...member,
          status: 'unmatched',
          groupId: null,
          mergeOfferGroupId: null,
        });
      } else if (claimed.length === 0) {
        return [];
      }
    }
    return claimed;
  }

  /**
   * Event cancelled or otherwise gone: every chat ends and every entry is withdrawn.
   *
   * `shouldFailWhenChatStaysOpen` is for a gathering about to be hard-deleted
   * (ENG-433): the delete cascade removes the group rows, so a chat left open
   * now would outlive its group for good. The first chat that cannot be ended
   * throws, before its group is marked dissolved and before any entry moves,
   * so the caller can abort and a retry picks up the same groups. The
   * reconcile pass leaves it off: a chat that fails to end is logged, its
   * group stays open, and the pass retries it on its next tick.
   */
  async dissolveEventGroups(
    eventId: string,
    options: { shouldFailWhenChatStaysOpen?: boolean } = {},
  ): Promise<void> {
    for (const group of await this.activeGroupsOf(eventId)) {
      await this.dissolveGroup(group, options);
    }
    await this.entries.update(
      { eventId },
      {
        status: 'withdrawn',
        mergeOfferGroupId: null,
        lens: null,
        lensConsentedAt: null,
      },
    );
  }

  private async solveAndPersist(
    event: EventSummary,
    config: EventMatchConfig,
    pool: MatchPool,
    seedLabel: string,
  ): Promise<{
    groupsFormed: number;
    unplaced: EventMatchEntry[];
    returnedToWaiting: EventMatchEntry[];
  }> {
    const result = formGroups(pool.graph, pool.units, {
      seed: seedFrom(seedLabel),
      minAffinity: MIN_AFFINITY,
    });
    if (result.hitTimeBudget) {
      this.logger.warn(
        `Go together solver hit its time budget for ${seedLabel} (${pool.members.length} people)`,
      );
    }
    let groupsFormed = 0;
    const returnedToWaiting: EventMatchEntry[] = [];
    for (const unitIndexes of result.groups) {
      const outcome = await this.persistGroup(
        event,
        config,
        pool,
        personIndexesOf(pool.units, unitIndexes),
        seedLabel,
      );
      if (outcome.isFormed) groupsFormed += 1;
      returnedToWaiting.push(...outcome.returnedToWaiting);
    }
    const unplaced = unplacedUnitIndexes(
      pool.units.length,
      result.groups,
    ).flatMap((unitIndex) => unitEntries(pool, unitIndex));
    return { groupsFormed, unplaced, returnedToWaiting };
  }

  /**
   * Saves one solver group, then seats its members with a guarded update.
   * Whoever withdrew while the solver ran is left out: the group's summary is
   * recomputed from who was actually seated, and when fewer than 3 remain the
   * group is dissolved before any chat opens and those members go back to
   * `waiting` for the late-joiner pass.
   */
  private async persistGroup(
    event: EventSummary,
    config: EventMatchConfig,
    pool: MatchPool,
    personIndexes: number[],
    seedLabel: string,
  ): Promise<{ isFormed: boolean; returnedToWaiting: EventMatchEntry[] }> {
    const memberEntries = personIndexes.flatMap((person) => {
      const member = pool.members[person];
      return member ? [member.entry] : [];
    });
    const group = await this.groups.save(
      this.groups.create({
        eventId: event.id,
        ...this.groupSummary(config, pool, personIndexes),
        scoringVersion: SCORING_VERSION,
        solverSeedLabel: seedLabel,
        conversationId: null,
        dissolvedAt: null,
      }),
    );
    const seatedEntries = await guardedMoveIntoGroup(
      this.entries,
      memberEntries,
      group.id,
      PENDING_STATUSES,
    );
    if (seatedEntries.length < 3) {
      await this.groups.update(group.id, { dissolvedAt: new Date() });
      if (seatedEntries.length > 0) {
        await this.entries.update(
          {
            id: In(seatedEntries.map((entry) => entry.id)),
            status: 'grouped',
            groupId: group.id,
          },
          { status: 'waiting', groupId: null },
        );
      }
      return { isFormed: false, returnedToWaiting: seatedEntries };
    }
    if (seatedEntries.length < memberEntries.length) {
      const seatedIds = new Set(seatedEntries.map((entry) => entry.id));
      const seatedPeople = personIndexes.filter((person) =>
        seatedIds.has(pool.members[person]?.entry.id ?? ''),
      );
      await this.groups.update(
        group.id,
        this.groupSummary(config, pool, seatedPeople),
      );
    }
    try {
      const { conversationId } = await this.groupsService.createMatchedGroup({
        ownerUserId: await this.house.houseUserId(),
        memberUserIds: seatedEntries.map((entry) => entry.userId),
        title: event.title,
        description: config.meetingPointNote,
        eventMatchGroupId: group.id,
      });
      await this.groups.update(group.id, { conversationId });
      group.conversationId = conversationId;
    } catch (error) {
      this.logger.error(
        `Go together chat for group ${group.id} failed: ${describeError(error)}`,
      );
    }
    await this.notifyGroupReady(event, group, seatedEntries);
    return { isFormed: true, returnedToWaiting: [] };
  }

  /** Band, reasons and pair components for the given people. */
  private groupSummary(
    config: EventMatchConfig,
    pool: MatchPool,
    personIndexes: number[],
  ): Pick<EventMatchGroup, 'band' | 'reasons' | 'pairComponents'> {
    return {
      band: groupBand(
        groupMinimumAffinity(pool.graph, pool.units, personIndexes),
      ),
      reasons: buildGroupReasons(
        personIndexes.flatMap((person) => {
          const candidate = pool.members[person]?.candidate;
          return candidate ? [candidate] : [];
        }),
        pool.context.interestIdf,
        config.hostQuestions,
      ),
      pairComponents: buildPairComponents(pool, personIndexes),
    };
  }

  /** Sets entries `unmatched`. Non-final notices go out once per member;
   *  the final notice goes to everyone and re-stamps the timestamp. */
  private async markUnmatched(
    event: EventSummary,
    unmatchedEntries: EventMatchEntry[],
    isFinal: boolean,
  ): Promise<void> {
    const toNotify = isFinal
      ? unmatchedEntries
      : unmatchedEntries.filter((entry) => entry.unmatchedNotifiedAt === null);
    const notifiedIds = new Set(toNotify.map((entry) => entry.id));
    const silentIds = unmatchedEntries
      .filter((entry) => !notifiedIds.has(entry.id))
      .map((entry) => entry.id);
    if (toNotify.length > 0) {
      const result = await this.entries.update(
        { id: In([...notifiedIds]), status: In(PENDING_STATUSES) },
        { status: 'unmatched', groupId: null, unmatchedNotifiedAt: new Date() },
      );
      // Only those the guarded update took: a member who withdrew or was
      // placed meanwhile gets no "no group this time".
      const changed = await confirmChanged(
        this.entries,
        toNotify,
        result.affected,
        {
          status: 'unmatched',
        },
      );
      await this.notify(
        changed.map((entry) => entry.userId),
        NotificationType.GoTogetherUnmatched,
        { ...this.eventPayload(event), isFinal },
      );
    }
    if (silentIds.length > 0) {
      await this.entries.update(
        { id: In(silentIds), status: In(PENDING_STATUSES) },
        { status: 'unmatched', groupId: null },
      );
    }
  }

  /**
   * After someone leaves: an empty group is dissolved; a group of one or two
   * before the gathering starts gets a merge offer per remaining unit (or a
   * null offer when nothing fits), sent with `GoTogetherMemberLeft`. Offers
   * reserve no seat, so `acceptMerge` checks again. While Go together is held
   * dark (PRD-422) the empty group is still dissolved, and no offer or notice
   * goes out: the merge and group routes answer 404 until launch.
   */
  private async offerMergeIfSmall(group: EventMatchGroup): Promise<void> {
    if (group.dissolvedAt) return;
    const remaining = await this.entries.find({
      where: { groupId: group.id, status: 'grouped' },
    });
    if (remaining.length === 0) return this.dissolveGroup(group);
    if (remaining.length >= 3 || !isGoTogetherLaunched()) return;
    const event = await this.loadEvent(group.eventId);
    if (!isGatheringUpcoming(event, new Date())) return;
    const otherGroups = (await this.activeGroupsOf(group.eventId)).filter(
      (other) => other.id !== group.id,
    );
    const offerByEntryId = new Map<string, string>();
    if (otherGroups.length > 0) {
      const { pool, groupLists, candidateUnits } = await this.placementPool(
        remaining,
        otherGroups,
      );
      const placements = planPlacements(pool, groupLists, candidateUnits, {
        ...PLACEMENT_LIMITS,
        shouldReserveSeats: false,
      });
      for (const { unitIndex, groupIndex } of placements) {
        const targetGroupId = otherGroups[groupIndex]?.id;
        if (!targetGroupId) continue;
        for (const member of unitEntries(pool, unitIndex)) {
          offerByEntryId.set(member.id, targetGroupId);
        }
      }
    }
    for (const member of remaining) {
      const mergeOfferGroupId = offerByEntryId.get(member.id) ?? null;
      await this.entries.update({ id: member.id }, { mergeOfferGroupId });
      await this.notify(
        [member.userId],
        NotificationType.GoTogetherMemberLeft,
        { ...this.eventPayload(event), groupId: group.id, mergeOfferGroupId },
      );
    }
  }

  /**
   * Places `candidates` into `targetGroups` unit by unit, reserving each seat,
   * then moves them in, seats them in the chat and sends `GoTogetherGroupReady`.
   * `poolOptions` goes to `placementPool`. Returns the entries that were
   * placed.
   */
  private async seatCandidates(
    event: EventSummary,
    candidates: EventMatchEntry[],
    targetGroups: EventMatchGroup[],
    fromStatuses: EntryStatus[],
    poolOptions: PlacementPoolOptions = {},
  ): Promise<EventMatchEntry[]> {
    const { pool, groupLists, candidateUnits } = await this.placementPool(
      candidates,
      targetGroups,
      poolOptions,
    );
    const placements = planPlacements(
      pool,
      groupLists,
      orderHardestFirst(pool, candidateUnits),
      { ...PLACEMENT_LIMITS, shouldReserveSeats: true },
    );
    const placed: EventMatchEntry[] = [];
    for (const { unitIndex, groupIndex } of placements) {
      const targetGroup = targetGroups[groupIndex];
      if (!targetGroup) continue;
      const joiners = await this.moveIntoGroup(
        targetGroup,
        unitEntries(pool, unitIndex),
        fromStatuses,
      );
      if (joiners.length === 0) continue;
      await this.notifyGroupReady(event, targetGroup, joiners);
      placed.push(...joiners);
    }
    return placed;
  }

  /** Whether every member of `moving` still fits `targetGroup` together. */
  private async fitsWhole(
    moving: EventMatchEntry[],
    targetGroup: EventMatchGroup,
  ): Promise<boolean> {
    const { pool, groupLists, candidateUnits } = await this.placementPool(
      moving,
      [targetGroup],
    );
    const candidatePeople = personIndexesOf(pool.units, candidateUnits);
    if (candidatePeople.length !== moving.length) return false;
    const placements = planPlacements(pool, groupLists, candidateUnits, {
      ...PLACEMENT_LIMITS,
      shouldReserveSeats: true,
    });
    return placements.length === candidateUnits.length;
  }

  /** One pool of the candidates plus everyone seated in `targetGroups`. */
  private async placementPool(
    candidates: EventMatchEntry[],
    targetGroups: EventMatchGroup[],
    { keepAnswerlessEntryIds }: PlacementPoolOptions = {},
  ): Promise<PlacementPool> {
    const seated = await this.entries.find({
      where: {
        groupId: In(targetGroups.map((group) => group.id)),
        status: 'grouped',
      },
    });
    const { pool } = await this.pool.buildPool([...seated, ...candidates], {
      includeAnchors: false,
      ...(keepAnswerlessEntryIds ? { keepAnswerlessEntryIds } : {}),
    });
    const candidateIds = new Set(candidates.map((entry) => entry.id));
    const groupLists = groupUnitLists(
      pool,
      targetGroups.map((group) => group.id),
    );
    // Defence in depth: a group whose seated members are not all in its unit
    // list would hide a seat and that member's hard filters from placement,
    // so such a group takes nobody (an empty list is never a target).
    targetGroups.forEach((group, groupIndex) => {
      const seatedCount = seated.filter(
        (entry) => entry.groupId === group.id,
      ).length;
      const coveredCount = personIndexesOf(
        pool.units,
        groupLists[groupIndex] ?? [],
      ).length;
      if (coveredCount !== seatedCount) {
        this.logger.warn(
          `Go together group ${group.id} is not fully in the pool (${coveredCount} of ${seatedCount}); it takes no one this pass`,
        );
        groupLists[groupIndex] = [];
      }
    });
    return {
      pool,
      groupLists,
      candidateUnits: unitIndexesWhere(pool, (entry) =>
        candidateIds.has(entry.id),
      ),
    };
  }

  /** The entry plus its accepted partner when that partner is grouped in the
   *  same group and is not `excludedUserId`. */
  private async movingUnit(
    entry: EventMatchEntry,
    excludedUserId: string | null,
  ): Promise<EventMatchEntry[]> {
    const partnerId = entry.pairPartnerId;
    if (
      entry.pairStatus !== 'accepted' ||
      !partnerId ||
      partnerId === excludedUserId ||
      !entry.groupId
    ) {
      return [entry];
    }
    const partner = await this.entries.findOne({
      where: {
        eventId: entry.eventId,
        userId: partnerId,
        status: 'grouped',
        groupId: entry.groupId,
      },
    });
    const isMutual =
      partner?.pairStatus === 'accepted' &&
      partner.pairPartnerId === entry.userId;
    return partner && isMutual ? [entry, partner] : [entry];
  }

  /**
   * Moves `members` into the existing `group` (guarded on their expected
   * status, for seated members their current group, and on the group's seat
   * count under a row lock), then takes only those the write actually moved
   * out of `previousConversationId` and seats them in the group's chat. The
   * chat seat is an `addMatchedMembers` seat, which carries the join history
   * floor. Returns the moved entries.
   */
  private async moveIntoGroup(
    group: EventMatchGroup,
    members: EventMatchEntry[],
    fromStatuses: EntryStatus[],
    previousConversationId: string | null = null,
  ): Promise<EventMatchEntry[]> {
    const moved = await guardedMoveIntoOpenGroup(
      this.entries,
      members,
      group.id,
      fromStatuses,
      LATE_JOIN_MAX_SIZE,
    );
    if (previousConversationId) {
      for (const member of moved) {
        await this.leaveChat(previousConversationId, member.userId);
      }
    }
    if (moved.length === 0 || !group.conversationId) return moved;
    try {
      await this.groupsService.addMatchedMembers(
        group.conversationId,
        await this.house.houseUserId(),
        moved.map((member) => member.userId),
      );
    } catch (error) {
      this.logger.error(
        `Go together could not seat members in group ${group.id}: ${describeError(error)}`,
      );
    }
    return moved;
  }

  /**
   * Ends the group's chat, then marks the group dissolved. When the chat
   * call fails, the group stays open, so a cancelled gathering's reconcile
   * pass (and a hard delete's strict pass) finds it again and retries; with
   * `shouldFailWhenChatStaysOpen` the error is rethrown as well. A refusal
   * that no retry can change (`isPermanentChatRefusal`: the chat is gone, is
   * no matched chat, or the house holds no owner seat in it) is logged and
   * the group is marked dissolved all the same, since the house has nothing
   * left it can close there.
   */
  private async dissolveGroup(
    group: EventMatchGroup,
    { shouldFailWhenChatStaysOpen = false } = {},
  ): Promise<void> {
    if (group.conversationId) {
      try {
        await this.groupsService.dissolveMatchedGroup(
          group.conversationId,
          await this.house.houseUserId(),
        );
      } catch (error) {
        if (!isPermanentChatRefusal(error)) {
          this.logger.error(
            `Go together could not end the chat of group ${group.id}; the group stays open for a retry: ${describeError(error)}`,
          );
          if (shouldFailWhenChatStaysOpen) throw error;
          return;
        }
        this.logger.error(
          `Go together cannot end the chat of group ${group.id} as the house; the group is closed without it: ${describeError(error)}`,
        );
      }
    }
    await this.groups.update(group.id, { dissolvedAt: new Date() });
  }

  private async leaveChat(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    try {
      // Flagged so the chat does not announce a matched leave back to the
      // listener: every caller here writes the entry itself.
      await this.groupsService.leaveGroup(conversationId, userId, {
        isGoTogetherRemoval: true,
      });
    } catch (error) {
      this.logger.error(
        `Go together could not remove ${userId} from ${conversationId}: ${describeError(error)}`,
      );
    }
  }

  private notifyGroupReady(
    event: EventSummary,
    group: EventMatchGroup,
    members: EventMatchEntry[],
  ): Promise<void> {
    return this.notify(
      members.map((member) => member.userId),
      NotificationType.GoTogetherGroupReady,
      {
        ...this.eventPayload(event),
        groupId: group.id,
        conversationId: group.conversationId,
      },
    );
  }

  /** A failed notification is logged; it never undoes a formation write. */
  private async notify(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.notifications.createForRecipients(userIds, type, payload);
    } catch (error) {
      this.logger.error(
        `Go together notification ${type} failed: ${describeError(error)}`,
      );
    }
  }

  private eventPayload(event: EventSummary): Record<string, unknown> {
    return {
      eventId: event.id,
      eventSlug: event.slug,
      eventTitle: event.title,
    };
  }

  /** Atomic bump, so a host editing the config mid-run keeps their edit. */
  private async nextSeedLabel(config: EventMatchConfig): Promise<string> {
    await this.configs.increment({ eventId: config.eventId }, 'runCount', 1);
    const bumped = await this.configs.findOne({
      where: { eventId: config.eventId },
      select: { eventId: true, runCount: true },
    });
    const runCount = bumped?.runCount ?? config.runCount + 1;
    return `${config.eventId}:${runCount}`;
  }

  private activeGroupsOf(eventId: string): Promise<EventMatchGroup[]> {
    return this.groups.find({
      where: { eventId, dissolvedAt: IsNull() },
      order: { formedAt: 'ASC', id: 'ASC' },
    });
  }

  private loadEvent(eventId: string): Promise<EventSummary | null> {
    return this.events.findOne({
      where: { id: eventId },
      select: { id: true, slug: true, title: true, startAt: true },
    });
  }

  private async loadEventAndConfig(
    eventId: string,
  ): Promise<{ event: EventSummary; config: EventMatchConfig } | null> {
    const [event, config] = await Promise.all([
      this.loadEvent(eventId),
      this.configs.findOne({ where: { eventId } }),
    ]);
    if (!event || !config) {
      this.logger.warn(`Go together skipped ${eventId}: no event or config`);
      return null;
    }
    return { event, config };
  }
}
