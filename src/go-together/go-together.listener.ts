import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { EVENT_DELETING, EventDeletingEvent } from '../events/event.events';
import {
  MATCHED_GROUP_MEMBER_LEFT,
  MatchedGroupMemberLeftEvent,
} from '../messaging/messaging.events';
import { MEMBER_BLOCKED, MemberBlockedEvent } from '../social/social.events';
import {
  EntryStatus,
  EventMatchEntry,
} from './entities/event-match-entry.entity';
import { BLOCK_MOVE_GRACE_MS } from './go-together-formation.helpers';
import { GoTogetherFormationService } from './go-together-formation.service';

/** Entries a block can still change. Withdrawn entries are history. */
const LIVE_ENTRY_STATUSES: EntryStatus[] = ['waiting', 'grouped', 'unmatched'];

@Injectable()
export class GoTogetherListener {
  private readonly logger = new Logger(GoTogetherListener.name);

  constructor(
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    private readonly formation: GoTogetherFormationService,
  ) {}

  /**
   * A gathering is about to be hard-deleted (ENG-433). The delete cascades its
   * config, groups and entries, and a matched chat whose group row is gone
   * loses its `event_match_group_id`, so it would carry on as an ordinary
   * house-owned group with no banner and outside the closed-group guard.
   * Every matched chat is dissolved here first, the way the reconcile pass
   * does for a cancelled gathering. Errors propagate on purpose
   * (`suppressErrors: false`): `EventsService.remove` awaits this through
   * `emitAsync` and keeps the gathering when a chat could not be ended.
   */
  @OnEvent(EVENT_DELETING, { suppressErrors: false })
  async onEventDeleting(event: EventDeletingEvent): Promise<void> {
    await this.formation.dissolveEventGroups(event.eventId, {
      shouldFailWhenChatStaysOpen: true,
    });
  }

  /** A block must take effect in a shared chat right away (spec 3.6); the
   *  5-minute reconcile pass is too slow for someone who just blocked a
   *  stranger they are about to meet. It is the path for every block. A
   *  block from the group sheet also awaits the move itself
   *  (`GoTogetherGroupService.blockMember`), and this listener runs the same
   *  move at the same time; whichever run claims the blocker first wins, and
   *  the other changes nothing. */
  @OnEvent(MEMBER_BLOCKED)
  async onMemberBlocked(event: MemberBlockedEvent): Promise<void> {
    try {
      await this.handleBlock(event.blockerId, event.blockedId, new Date());
    } catch (error) {
      this.logger.error(
        `Go together block handling failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  /**
   * Leaving the matched chat follows the same rule as the group sheet's
   * Leave (spec 3.6, PRD-418), through the one shared
   * `GoTogetherFormationService.leaveGroup`: before the gathering starts the
   * entry is withdrawn, an accepted partner goes solo and the group left
   * behind gets a merge offer when it got small; from the start onward only
   * the chat membership ends, and the member stays in the group record and
   * keeps the meet-again page. Only an entry still seated in that group is
   * touched. `leaveGroup` calls the chat's leave again, which is a no-op for
   * a member who already left and flagged as Go together's own removal, so
   * no second event comes back here.
   */
  @OnEvent(MATCHED_GROUP_MEMBER_LEFT)
  async onMatchedGroupMemberLeft(
    event: MatchedGroupMemberLeftEvent,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      const seatedEntry = await this.entries.findOne({
        where: {
          userId: event.userId,
          groupId: event.eventMatchGroupId,
          status: 'grouped',
        },
      });
      if (!seatedEntry) return;
      await this.formation.leaveGroup(seatedEntry, now);
    } catch (error) {
      this.logger.error(
        `Go together chat leave handling failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  private async handleBlock(
    blockerId: string,
    blockedId: string,
    now: Date,
  ): Promise<void> {
    if (blockerId === blockedId) return;
    const liveEntries = await this.entries.find({
      where: {
        userId: In([blockerId, blockedId]),
        status: In(LIVE_ENTRY_STATUSES),
      },
    });
    const eventIds = [...new Set(liveEntries.map((entry) => entry.eventId))];
    if (eventIds.length === 0) return;
    const upcomingEvents = await this.events.find({
      where: {
        id: In(eventIds),
        startAt: MoreThan(new Date(now.getTime() - BLOCK_MOVE_GRACE_MS)),
      },
      select: ['id'],
    });

    for (const { id: eventId } of upcomingEvents) {
      const eventEntries = liveEntries.filter(
        (entry) => entry.eventId === eventId,
      );
      const blockerEntry = eventEntries.find(
        (entry) => entry.userId === blockerId,
      );
      const blockedEntry = eventEntries.find(
        (entry) => entry.userId === blockedId,
      );

      // 1. An accepted pair or a pending invite between the two ends: each
      //    entry pointing at the other goes back to solo.
      const pairedEntryIds = [
        blockerEntry?.pairPartnerId === blockedId ? blockerEntry.id : null,
        blockedEntry?.pairPartnerId === blockerId ? blockedEntry.id : null,
      ].filter((entryId): entryId is string => entryId !== null);
      if (pairedEntryIds.length > 0) {
        await this.entries.update(
          { id: In(pairedEntryIds) },
          { pairStatus: 'none', pairPartnerId: null },
        );
      }

      // 2. Sharing a group: the blocker moves out.
      const isSharingGroup =
        blockerEntry?.status === 'grouped' &&
        blockedEntry?.status === 'grouped' &&
        blockerEntry.groupId !== null &&
        blockerEntry.groupId === blockedEntry.groupId;
      if (isSharingGroup) {
        await this.formation.moveAfterBlock(eventId, blockerId, blockedId);
      }
    }
  }
}
