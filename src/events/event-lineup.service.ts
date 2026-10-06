import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  CohostInviteInviterView,
  toCohostInviteEventSummaryView,
  toCohostInviteInviterView,
} from './cohost-invite-response';
import { CreateLineupInviteDto } from './dto/create-lineup-invite.dto';
import {
  EventLineupEntry,
  EventLineupEntryStatus,
} from './entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventLineupDTO, toLineupEntryView } from './event-response';
import {
  EVENT_LINEUP_ANSWERED,
  EVENT_LINEUP_INVITED,
  EventLineupAnsweredEvent,
  EventLineupInvitedEvent,
} from './event.events';
import { EventsService } from './events.service';
import { LineupInviteView, toLineupInviteView } from './lineup-invite-response';

/** Pending plus accepted rows one lineup may hold. */
export const MAX_LINEUP_ENTRIES = 50;

const OPEN_STATUSES = [
  EventLineupEntryStatus.Pending,
  EventLineupEntryStatus.Accepted,
];

// The taxonomy code a moderator takedown is recorded under for a gathering,
// the same value `EventsService.SUBJECT_TYPE` uses for its detail gate. Kept
// as its own constant here because that one is private to `EventsService`.
const EVENT_MODERATION_SUBJECT_TYPE = 'event';

interface InsertedLineupRow {
  id: string;
}

/**
 * A gathering's lineup ("who performed") as invitations (2026-10-06). An
 * organizer invites a connection, or anyone going, with a craft; the member
 * accepts or declines; only accepted rows are public. Replaces the old
 * host-only replace-all on `EventsService`.
 */
@Injectable()
export class EventLineupService {
  constructor(
    @InjectRepository(EventLineupEntry)
    private readonly lineupEntries: Repository<EventLineupEntry>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
    private readonly eventsService: EventsService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly contentModeration: ContentModerationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Same visibility gate as attendees: a draft, gated or taken-down event
  // 404s for a viewer who cannot see it.
  async getLineup(slug: string, viewerId: string): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    const isOrganizer = await this.eventsService.assertCanView(event, viewerId);
    return this.buildLineupDTO(event.id, viewerId, isOrganizer);
  }

  async invite(
    slug: string,
    actorId: string,
    dto: CreateLineupInviteDto,
  ): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const inviteeProfile = await this.findProfileOr404(dto.memberSlug);
    if (inviteeProfile.userId === actorId) {
      throw new BadRequestException('You cannot invite yourself');
    }
    // A suspended, banned or erased account answers like an unknown slug, so
    // the organizer learns nothing about that account's standing.
    const inviteeUser = await this.usersService.findById(inviteeProfile.userId);
    if (!inviteeUser || inviteeUser.status !== UserStatus.Active) {
      throw new NotFoundException('Member not found');
    }
    await this.assertInvitable(event.id, actorId, inviteeProfile.userId);

    const existing = await this.lineupEntries.findOne({
      where: { eventId: event.id, userId: inviteeProfile.userId },
    });
    if (existing && existing.status !== EventLineupEntryStatus.Declined) {
      throw new ConflictException(
        'This member is already on the lineup or invited',
      );
    }
    const openCount = await this.lineupEntries.count({
      where: { eventId: event.id, status: In(OPEN_STATUSES) },
    });
    if (openCount >= MAX_LINEUP_ENTRIES) {
      throw new BadRequestException(
        `A lineup can have at most ${MAX_LINEUP_ENTRIES} entries`,
      );
    }

    const entryId = existing
      ? await this.reinviteDeclined(existing.id, actorId, dto.role)
      : await this.insertPending(
          event.id,
          inviteeProfile.userId,
          actorId,
          dto.role,
        );

    this.eventEmitter.emit(EVENT_LINEUP_INVITED, {
      entryId,
      eventId: event.id,
      eventSlug: event.slug,
      inviterId: actorId,
      inviteeId: inviteeProfile.userId,
      role: dto.role,
    } satisfies EventLineupInvitedEvent);

    return this.buildLineupDTO(event.id, actorId, true);
  }

  async changeRole(
    slug: string,
    actorId: string,
    memberSlug: string,
    role: string,
  ): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const profile = await this.findProfileOr404(memberSlug);
    const result = await this.lineupEntries.update(
      { eventId: event.id, userId: profile.userId },
      { role },
    );
    if (!result.affected) {
      throw new NotFoundException('This member is not on the lineup');
    }
    return this.buildLineupDTO(event.id, actorId, true);
  }

  // Removes the row whatever its status. Withdrawing a pending invite leaves
  // the member's notification in place; the invite page then says the
  // invite is no longer open.
  async remove(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const profile = await this.findProfileOr404(memberSlug);
    const result = await this.lineupEntries.delete({
      eventId: event.id,
      userId: profile.userId,
    });
    if (!result.affected) {
      throw new NotFoundException('This member is not on the lineup');
    }
    return this.buildLineupDTO(event.id, actorId, true);
  }

  async leave(slug: string, viewerId: string): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    const result = await this.lineupEntries.delete({
      eventId: event.id,
      userId: viewerId,
      status: EventLineupEntryStatus.Accepted,
    });
    if (!result.affected) {
      throw new NotFoundException('You are not on this lineup');
    }
    return { ok: true };
  }

  // Deliberately skips `assertCanView`: a member invited to an audience-gated
  // gathering must still be able to read and answer their invite. The view
  // carries only what the invite page shows. The moderation takedown that
  // `assertCanView` would apply is checked on its own below.
  async getInvite(
    entryId: string,
    viewerId: string,
  ): Promise<LineupInviteView> {
    const entry = await this.findOwnEntryOr404(entryId, viewerId);
    const event = await this.events.findOne({ where: { id: entry.eventId } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    await this.assertEventNotTakenDown(event.id);
    // Both ids are null when the inviter's account and the host's account
    // are erased; the invite then shows no inviter card.
    const inviterUserId = entry.invitedById ?? event.hostId;
    const inviter = inviterUserId
      ? await this.loadInviterView(inviterUserId, viewerId)
      : null;
    return toLineupInviteView(
      entry,
      toCohostInviteEventSummaryView(event, null, null),
      inviter,
    );
  }

  async respond(
    entryId: string,
    viewerId: string,
    outcome: 'accepted' | 'declined',
  ): Promise<{ id: string; status: EventLineupEntryStatus }> {
    const entry = await this.findOwnEntryOr404(entryId, viewerId);
    if (entry.status !== EventLineupEntryStatus.Pending) {
      throw new ConflictException('This invite has already been answered');
    }
    await this.assertEventNotTakenDown(entry.eventId);
    const nextStatus =
      outcome === 'accepted'
        ? EventLineupEntryStatus.Accepted
        : EventLineupEntryStatus.Declined;
    // Conditional on still being pending, so a double tap or a withdraw that
    // lands first answers 409 and emits nothing.
    const result = await this.lineupEntries.update(
      { id: entry.id, status: EventLineupEntryStatus.Pending },
      { status: nextStatus, respondedAt: new Date() },
    );
    if (!result.affected) {
      throw new ConflictException('This invite has already been answered');
    }
    const event = await this.events.findOne({ where: { id: entry.eventId } });
    const recipientId = event
      ? await this.resolveReplyRecipientId(event, entry.invitedById)
      : null;
    if (event && recipientId && recipientId !== viewerId) {
      this.eventEmitter.emit(EVENT_LINEUP_ANSWERED, {
        entryId: entry.id,
        eventId: event.id,
        eventSlug: event.slug,
        performerId: viewerId,
        recipientId,
        role: entry.role,
        outcome,
      } satisfies EventLineupAnsweredEvent);
    }
    return { id: entry.id, status: nextStatus };
  }

  // --- internals ---

  // The invite page and its answer 404 once a moderator has hidden or removed
  // the gathering, with the same message as an unknown invite id.
  private async assertEventNotTakenDown(eventId: string): Promise<void> {
    const moderation = await this.contentModeration.stateFor(
      EVENT_MODERATION_SUBJECT_TYPE,
      eventId,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Invite not found');
    }
  }

  // The answer goes to the organizer who sent the invite while they still
  // organize the gathering. A co-host who has since stepped down, or whose
  // account is gone, hands the answer to the host.
  private async resolveReplyRecipientId(
    event: Event,
    invitedById: string | null,
  ): Promise<string | null> {
    if (
      invitedById &&
      (await this.eventsService.isOrganizer(event.id, invitedById))
    ) {
      return invitedById;
    }
    return event.hostId;
  }

  // The co-host invite's inviter card for `getInvite`. Null when the
  // inviter has no profile left.
  private async loadInviterView(
    inviterUserId: string,
    viewerId: string,
  ): Promise<CohostInviteInviterView | null> {
    const [inviterProfile, hostedEventsCount, mutualCounts] = await Promise.all(
      [
        this.profiles.findOne({ where: { userId: inviterUserId } }),
        this.events.count({
          where: { hostId: inviterUserId, status: EventStatus.Published },
        }),
        this.connectionsService.mutualCountsByUserIds(viewerId, [
          inviterUserId,
        ]),
      ],
    );
    if (!inviterProfile) {
      return null;
    }
    return toCohostInviteInviterView(
      inviterProfile,
      hostedEventsCount,
      mutualCounts.get(inviterUserId) ?? 0,
    );
  }

  private async buildLineupDTO(
    eventId: string,
    viewerId: string,
    isOrganizer: boolean,
  ): Promise<EventLineupDTO> {
    const rows = await this.lineupEntries.find({
      where: { eventId },
      order: { createdAt: 'ASC' },
    });
    const userIds = rows.map((row) => row.userId);
    const profileRows = userIds.length
      ? await this.profiles.find({ where: { userId: In(userIds) } })
      : [];
    const profileByUserId = new Map(
      profileRows.map((profile) => [profile.userId, profile]),
    );
    const visibleRows = isOrganizer
      ? rows
      : rows.filter((row) => row.status === EventLineupEntryStatus.Accepted);
    const entries = visibleRows
      .map((row) => toLineupEntryView(row, profileByUserId.get(row.userId)))
      .filter((view): view is NonNullable<typeof view> => view !== null);
    const viewerRow = rows.find((row) => row.userId === viewerId);
    const viewerEntry = viewerRow
      ? toLineupEntryView(viewerRow, profileByUserId.get(viewerRow.userId))
      : null;
    return { entries, viewerEntry };
  }

  private async insertPending(
    eventId: string,
    userId: string,
    actorId: string,
    role: string,
  ): Promise<string> {
    const result = await this.lineupEntries
      .createQueryBuilder()
      .insert()
      .into(EventLineupEntry)
      .values({
        eventId,
        userId,
        role,
        status: EventLineupEntryStatus.Pending,
        invitedById: actorId,
        respondedAt: null,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    const inserted = ((result.raw as InsertedLineupRow[]) ?? [])[0];
    if (!inserted) {
      throw new ConflictException(
        'This member is already on the lineup or invited',
      );
    }
    return inserted.id;
  }

  private async reinviteDeclined(
    entryId: string,
    actorId: string,
    role: string,
  ): Promise<string> {
    const result = await this.lineupEntries.update(
      { id: entryId, status: EventLineupEntryStatus.Declined },
      {
        status: EventLineupEntryStatus.Pending,
        role,
        invitedById: actorId,
        respondedAt: null,
      },
    );
    if (!result.affected) {
      throw new ConflictException(
        'This member is already on the lineup or invited',
      );
    }
    return entryId;
  }

  // The API mirror of the picker: an organizer can invite their own
  // connections or anyone going, so the endpoint cannot be used to send
  // invites to strangers. A block in either direction answers with the same
  // 403 as an ineligible member, so the response does not reveal the block.
  private async assertInvitable(
    eventId: string,
    actorId: string,
    inviteeId: string,
  ): Promise<void> {
    const isBlocked = await this.blockFilter.isBlockedEitherWay(
      actorId,
      inviteeId,
    );
    if (isBlocked) {
      throw new ForbiddenException(
        'You can invite your connections or people going to this gathering',
      );
    }
    const [isConnected, isGoing] = await Promise.all([
      this.connectionsService.areConnected(actorId, inviteeId),
      this.rsvps.exists({
        where: { eventId, userId: inviteeId, status: RsvpStatus.Going },
      }),
    ]);
    if (!isConnected && !isGoing) {
      throw new ForbiddenException(
        'You can invite your connections or people going to this gathering',
      );
    }
  }

  private async assertOrganizer(
    eventId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.eventsService.isOrganizer(eventId, userId))) {
      throw new ForbiddenException('Only the host or a co-host can do that');
    }
  }

  private async loadEventOr404(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async findProfileOr404(memberSlug: string): Promise<Profile> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    return profile;
  }

  // 404 for anyone but the invited member, so invite ids leak nothing.
  private async findOwnEntryOr404(
    entryId: string,
    viewerId: string,
  ): Promise<EventLineupEntry> {
    const entry = await this.lineupEntries.findOne({ where: { id: entryId } });
    if (!entry || entry.userId !== viewerId) {
      throw new NotFoundException('Invite not found');
    }
    return entry;
  }
}
