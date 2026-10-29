import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  COMMUNITY_STAFF_ROLES,
  isCommunityStaffRole,
} from '../communities/community-staff-access';
import { CommunityMember } from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { resolveEffectiveRole } from '../communities/subcommunity-rules';
import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import { toCohostInviteInviterView } from './cohost-invite-response';
import { EventCohost } from './entities/event-cohost.entity';
import {
  EventCommunity,
  EventCommunityStatus,
} from './entities/event-community.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import {
  LeadCommunityRef,
  MAX_GUEST_COMMUNITIES,
  isPrivateCommunityWithheld,
} from './event-community-hosting';
import {
  EventCommunityInviteDetailView,
  EventGuestCommunityView,
  displayNameOf,
  toEventCommunityInviteDetailView,
  toEventGuestCommunityView,
} from './event-community-response';
import { areAttendeeCountsWithheld } from './event-response';
import { hasEnded } from './event-timing';
import {
  EVENT_COMMUNITY_INVITE_RESPONDED,
  EVENT_COMMUNITY_INVITED,
  EventCommunityInviteRespondedEvent,
  EventCommunityInvitedEvent,
} from './event.events';
import { EventsService } from './events.service';
import { GatheringFamily } from './gathering-family';
import { houseMusicEventError } from './house-music-event-errors';
import { isHouseAccountId } from './house-music-events';

/** Columns `RETURNING (*)` surfaces for a freshly inserted guest row. */
interface InsertedEventCommunityRow {
  id: string;
}

/** The invite row with the gathering and the guest community it joins. */
interface InviteContext {
  invite: EventCommunity;
  event: Event;
  community: Community;
}

/**
 * Guest communities on a gathering (2026-10-08). The organiser side
 * (`/events/:slug/communities`) invites, lists and removes; the guest side
 * (`/event-communities/:id`) reads, answers and leaves.
 *
 * Organiser means `EventsService.isOrganizer` (host or co-host). Answering
 * for a guest community takes standing there: owner, co-owner or mod by
 * effective role, so parent staff answer for a space. Removal by an
 * organiser and leaving by a guest notify nobody.
 */
@Injectable()
export class EventCommunitiesService {
  constructor(
    @InjectRepository(EventCommunity)
    private readonly eventCommunities: Repository<EventCommunity>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly eventsService: EventsService,
    private readonly membership: CommunityMembershipService,
    private readonly connectionsService: ConnectionsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listForOrganizer(
    slug: string,
    viewerId: string,
  ): Promise<EventGuestCommunityView[]> {
    const event = await this.loadEventBySlugOr404(slug);
    await this.assertOrganizer(event, viewerId);
    const rows = await this.eventCommunities.find({
      where: { eventId: event.id },
      order: { createdAt: 'ASC' },
    });
    if (!rows.length) return [];
    const guestsById = await this.communitiesByIds(
      rows.map((row) => row.communityId),
    );
    return rows.flatMap((row) => {
      const guest = guestsById.get(row.communityId);
      return guest ? [toEventGuestCommunityView(row, guest)] : [];
    });
  }

  async invite(
    slug: string,
    inviterId: string,
    communitySlug: string,
  ): Promise<EventGuestCommunityView> {
    const event = await this.loadEventBySlugOr404(slug);
    await this.assertOrganizer(event, inviterId);
    // A Music event QueerPulse hosts is open to every member, so it takes no
    // guest community either.
    if (
      event.gatheringFamily === GatheringFamily.Music &&
      (await isHouseAccountId(this.eventCommunities.manager, event.hostId))
    ) {
      throw houseMusicEventError('music_event_community_unavailable');
    }
    if (!event.communityId) {
      throw new BadRequestException(
        'Set a lead community before inviting guest communities',
      );
    }
    if (event.status === EventStatus.Cancelled) {
      throw new ConflictException('This event was cancelled');
    }
    if (hasEnded(event)) {
      throw new ConflictException('This event has already happened');
    }
    const community = await this.communities.findOne({
      where: { slug: communitySlug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    // Every public community, plus private ones the inviter belongs to. A
    // private community they are off answers the same 404 as an unknown
    // slug, so the endpoint confirms nothing.
    const inviterRole = await this.membership.effectiveRole(
      community,
      inviterId,
    );
    if (community.accessTier === AccessTier.Private && inviterRole === null) {
      throw new NotFoundException('Community not found');
    }
    if (community.id === event.communityId) {
      throw new ConflictException('This community already leads the event');
    }
    if (community.frozenAt !== null) {
      throw new ConflictException(
        'This community is frozen and cannot join an event right now',
      );
    }
    const existing = await this.eventCommunities.findOne({
      where: { eventId: event.id, communityId: community.id },
    });
    if (existing) {
      throw new ConflictException(
        'This community has already been invited to this event',
      );
    }
    // Spec decision 4: a community the inviter already runs or moderates
    // joins as accepted, with no invite step and no notification.
    const isAutoAccepted =
      inviterRole !== null && isCommunityStaffRole(inviterRole);
    const status = isAutoAccepted
      ? EventCommunityStatus.Accepted
      : EventCommunityStatus.Pending;
    // The cap count and the insert share one transaction that first locks the
    // event row, so two concurrent invites cannot both pass the count. The
    // locked read also re-checks the lead: a lead move that committed while
    // this invite waited on the lock has made this community the lead.
    const inserted = await this.eventCommunities.manager.transaction(
      async (manager) => {
        const locked = await manager.findOne(Event, {
          where: { id: event.id },
          select: { id: true, communityId: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (locked?.communityId === community.id) {
          throw new ConflictException('This community already leads the event');
        }
        const activeGuestCount = await manager.count(EventCommunity, {
          where: {
            eventId: event.id,
            status: In([
              EventCommunityStatus.Pending,
              EventCommunityStatus.Accepted,
            ]),
          },
        });
        if (activeGuestCount >= MAX_GUEST_COMMUNITIES) {
          throw new BadRequestException(
            `An event can have at most ${MAX_GUEST_COMMUNITIES} guest communities`,
          );
        }
        const result = await manager
          .createQueryBuilder()
          .insert()
          .into(EventCommunity)
          .values({
            eventId: event.id,
            communityId: community.id,
            status,
            invitedByUserId: inviterId,
            respondedByUserId: isAutoAccepted ? inviterId : null,
            respondedAt: isAutoAccepted ? new Date() : null,
          })
          .orIgnore()
          .returning('*')
          .execute();
        const insertedRows = (result.raw as InsertedEventCommunityRow[]) ?? [];
        return insertedRows[0];
      },
    );
    if (!inserted) {
      throw new ConflictException(
        'This community has already been invited to this event',
      );
    }
    if (!isAutoAccepted) {
      await this.emitInvited(event, community, inserted.id, inviterId);
    }
    return toEventGuestCommunityView({ id: inserted.id, status }, community);
  }

  async removeByOrganizer(
    slug: string,
    organizerId: string,
    communitySlug: string,
  ): Promise<void> {
    const event = await this.loadEventBySlugOr404(slug);
    await this.assertOrganizer(event, organizerId);
    // The slug resolves only among this gathering's own guest rows, and every
    // miss answers the same 404, so a private slug is never confirmed.
    const rows = await this.eventCommunities.find({
      where: { eventId: event.id },
    });
    const guestsById = await this.communitiesByIds(
      rows.map((row) => row.communityId),
    );
    const row = rows.find(
      (candidate) =>
        guestsById.get(candidate.communityId)?.slug === communitySlug,
    );
    if (!row) {
      throw new NotFoundException('This community is not on this event');
    }
    // A decline is final: the row stays so the community cannot be re-invited.
    // The delete matches only a pending or accepted row, so a guest that
    // declines or leaves after the read above keeps its declined row. Either
    // way the organiser gets the same 204.
    if (row.status === EventCommunityStatus.Declined) return;
    await this.eventCommunities.delete({
      id: row.id,
      status: In([EventCommunityStatus.Pending, EventCommunityStatus.Accepted]),
    });
  }

  async getInvite(
    id: string,
    viewerId: string,
  ): Promise<EventCommunityInviteDetailView> {
    const { invite, event, community } = await this.loadInviteContext(id);
    const [viewerRole, isOrganizer] = await Promise.all([
      this.membership.effectiveRole(community, viewerId),
      this.eventsService.isOrganizer(event.id, viewerId),
    ]);
    const isGuestStaff =
      viewerRole !== null && isCommunityStaffRole(viewerRole);
    if (!isGuestStaff && !isOrganizer) {
      throw new ForbiddenException('This invite is not visible to you');
    }
    return this.buildDetail(
      invite,
      event,
      community,
      viewerId,
      isGuestStaff,
      isOrganizer,
    );
  }

  async respond(
    id: string,
    responderId: string,
    decision: 'accept' | 'decline',
  ): Promise<EventCommunityInviteDetailView> {
    const { invite, event, community } = await this.loadInviteContext(id);
    await this.assertGuestStaff(community, responderId);
    if (invite.status !== EventCommunityStatus.Pending) {
      throw new ConflictException('This invite has already been answered');
    }
    if (event.status === EventStatus.Cancelled) {
      throw new ConflictException('This event was cancelled');
    }
    if (hasEnded(event)) {
      throw new ConflictException('This event has already happened');
    }
    if (community.frozenAt !== null) {
      throw new ConflictException(
        'This community is frozen and cannot answer right now',
      );
    }
    const nextStatus =
      decision === 'accept'
        ? EventCommunityStatus.Accepted
        : EventCommunityStatus.Declined;
    const respondedAt = new Date();
    // Pending-only: two mods answering at once both pass the check above,
    // and the second write must change nothing and answer 409.
    const result = await this.eventCommunities.update(
      { id: invite.id, status: EventCommunityStatus.Pending },
      { status: nextStatus, respondedByUserId: responderId, respondedAt },
    );
    if (!result.affected) {
      throw new ConflictException('This invite has already been answered');
    }
    const answered: EventCommunity = {
      ...invite,
      status: nextStatus,
      respondedByUserId: responderId,
      respondedAt,
    };
    await this.emitResponded(event, community, answered, responderId);
    const isOrganizer = await this.eventsService.isOrganizer(
      event.id,
      responderId,
    );
    return this.buildDetail(
      answered,
      event,
      community,
      responderId,
      true,
      isOrganizer,
    );
  }

  async leave(id: string, userId: string): Promise<void> {
    const invite = await this.loadInviteOr404(id);
    const community = await this.loadGuestCommunityOr404(invite.communityId);
    await this.assertGuestStaff(community, userId);
    if (invite.status !== EventCommunityStatus.Accepted) {
      throw new ConflictException('Only an accepted collab can be left');
    }
    // Leaving records a decline so the community cannot be re-invited, and it
    // leaves every accepted-only reader. Nobody is notified.
    const result = await this.eventCommunities.update(
      { id: invite.id, status: EventCommunityStatus.Accepted },
      {
        status: EventCommunityStatus.Declined,
        respondedByUserId: userId,
        respondedAt: new Date(),
      },
    );
    if (!result.affected) {
      throw new ConflictException('Only an accepted collab can be left');
    }
  }

  // --- internals ---

  private async buildDetail(
    invite: EventCommunity,
    event: Event,
    community: Community,
    viewerId: string,
    isGuestStaff: boolean,
    isOrganizer: boolean,
  ): Promise<EventCommunityInviteDetailView> {
    const isCountWithheld = areAttendeeCountsWithheld(event, isOrganizer);
    const inviterId = invite.invitedByUserId;
    const [
      leadCommunity,
      goingCount,
      waitlistCount,
      inviterProfile,
      responderProfile,
      hostedEventsCount,
      mutualCounts,
    ] = await Promise.all([
      this.visibleLeadCommunity(event, viewerId, isOrganizer),
      isCountWithheld
        ? Promise.resolve(null)
        : this.rsvps.count({
            where: { eventId: event.id, status: RsvpStatus.Going },
          }),
      isCountWithheld
        ? Promise.resolve(null)
        : this.rsvps.count({
            where: { eventId: event.id, status: RsvpStatus.Waitlisted },
          }),
      inviterId
        ? this.profiles.findOne({ where: { userId: inviterId } })
        : Promise.resolve(null),
      invite.respondedByUserId
        ? this.profiles.findOne({ where: { userId: invite.respondedByUserId } })
        : Promise.resolve(null),
      inviterId
        ? this.events.count({
            where: { hostId: inviterId, status: EventStatus.Published },
          })
        : Promise.resolve(0),
      inviterId
        ? this.connectionsService.mutualCountsByUserIds(viewerId, [inviterId])
        : Promise.resolve(new Map<string, number>()),
    ]);
    const isCancelled = event.status === EventStatus.Cancelled;
    const isPast = hasEnded(event);
    const isFrozen = community.frozenAt !== null;
    return toEventCommunityInviteDetailView({
      invite,
      event,
      community,
      leadCommunity,
      goingCount,
      waitlistCount,
      inviter:
        inviterId && inviterProfile
          ? toCohostInviteInviterView(
              inviterProfile,
              hostedEventsCount,
              mutualCounts.get(inviterId) ?? 0,
            )
          : null,
      respondedByName: responderProfile
        ? displayNameOf(responderProfile)
        : null,
      isCancelled,
      isPast,
      canRespond:
        isGuestStaff &&
        invite.status === EventCommunityStatus.Pending &&
        !isCancelled &&
        !isPast &&
        !isFrozen,
      canLeave: isGuestStaff && invite.status === EventCommunityStatus.Accepted,
    });
  }

  /** The lead as this viewer may see it, by the private-naming rule. */
  private async visibleLeadCommunity(
    event: Event,
    viewerId: string,
    isOrganizer: boolean,
  ): Promise<LeadCommunityRef | null> {
    if (!event.communityId) return null;
    const leadRef = await this.membership.hostingRefById(event.communityId);
    if (!leadRef) return null;
    const isOnRoster =
      leadRef.accessTier === AccessTier.Private && !isOrganizer
        ? await this.membership.isMember(event.communityId, viewerId)
        : false;
    if (
      isPrivateCommunityWithheld({
        accessTier: leadRef.accessTier,
        isOrganizer,
        isOnRoster,
      })
    ) {
      return null;
    }
    return { slug: leadRef.slug, name: leadRef.name };
  }

  private async emitInvited(
    event: Event,
    community: Community,
    inviteId: string,
    inviterId: string,
  ): Promise<void> {
    const [staffUserIds, leadRef] = await Promise.all([
      this.staffUserIdsOf(community),
      event.communityId
        ? this.membership.hostingRefById(event.communityId)
        : Promise.resolve(null),
    ]);
    this.eventEmitter.emit(EVENT_COMMUNITY_INVITED, {
      inviteId,
      eventId: event.id,
      eventSlug: event.slug,
      eventTitle: event.title,
      communitySlug: community.slug,
      communityName: community.name,
      leadCommunityName:
        leadRef && leadRef.accessTier !== AccessTier.Private
          ? leadRef.name
          : null,
      inviterId,
      recipientUserIds: staffUserIds.filter((userId) => userId !== inviterId),
    } satisfies EventCommunityInvitedEvent);
  }

  private async emitResponded(
    event: Event,
    community: Community,
    answered: EventCommunity,
    responderId: string,
  ): Promise<void> {
    const cohostRows = await this.cohosts.find({
      where: { eventId: event.id },
      select: { userId: true },
    });
    const organizerIds = new Set<string>([
      ...(event.hostId ? [event.hostId] : []),
      ...cohostRows.map((row) => row.userId),
    ]);
    organizerIds.delete(responderId);
    this.eventEmitter.emit(EVENT_COMMUNITY_INVITE_RESPONDED, {
      inviteId: answered.id,
      eventId: event.id,
      eventSlug: event.slug,
      eventTitle: event.title,
      communitySlug: community.slug,
      communityName: community.name,
      decision:
        answered.status === EventCommunityStatus.Accepted
          ? 'accepted'
          : 'declined',
      responderId,
      recipientUserIds: [...organizerIds],
    } satisfies EventCommunityInviteRespondedEvent);
  }

  /**
   * Every user holding owner, co-owner or mod standing in `community` by
   * effective role. At top level that is the staff roster rows. Inside a
   * space it is the space's own staff who still hold a parent row, plus the
   * parent's staff, who inherit standing in every space under it.
   */
  private async staffUserIdsOf(
    community: Pick<Community, 'id' | 'parentId'>,
  ): Promise<string[]> {
    const ownStaffRows = await this.communityMembers.find({
      where: {
        communityId: community.id,
        role: In([...COMMUNITY_STAFF_ROLES]),
      },
      select: { userId: true, role: true },
    });
    if (community.parentId === null) {
      return ownStaffRows.map((row) => row.userId);
    }
    const ownRoleByUserId = new Map(
      ownStaffRows.map((row) => [row.userId, row.role]),
    );
    const parentWhere: FindOptionsWhere<CommunityMember>[] = [
      { communityId: community.parentId, role: In([...COMMUNITY_STAFF_ROLES]) },
    ];
    if (ownRoleByUserId.size) {
      parentWhere.push({
        communityId: community.parentId,
        userId: In([...ownRoleByUserId.keys()]),
      });
    }
    const parentRows = await this.communityMembers.find({
      where: parentWhere,
      select: { userId: true, role: true },
    });
    const parentRoleByUserId = new Map(
      parentRows.map((row) => [row.userId, row.role]),
    );
    const candidateUserIds = new Set([
      ...ownRoleByUserId.keys(),
      ...parentRoleByUserId.keys(),
    ]);
    return [...candidateUserIds].filter((userId) => {
      const effectiveRole = resolveEffectiveRole({
        isSpace: true,
        ownRole: ownRoleByUserId.get(userId) ?? null,
        parentRole: parentRoleByUserId.get(userId) ?? null,
      });
      return effectiveRole !== null && isCommunityStaffRole(effectiveRole);
    });
  }

  private async assertOrganizer(event: Event, userId: string): Promise<void> {
    if (!(await this.eventsService.isOrganizer(event.id, userId))) {
      throw new ForbiddenException('Only the host or a co-host can do that');
    }
  }

  private async assertGuestStaff(
    community: Community,
    userId: string,
  ): Promise<void> {
    const role = await this.membership.effectiveRole(community, userId);
    if (role === null || !isCommunityStaffRole(role)) {
      throw new ForbiddenException(
        'Only the owner, a co-owner or a moderator of this community can do that',
      );
    }
  }

  private async loadEventBySlugOr404(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async loadInviteOr404(id: string): Promise<EventCommunity> {
    const invite = await this.eventCommunities.findOne({ where: { id } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    return invite;
  }

  private async loadGuestCommunityOr404(
    communityId: string,
  ): Promise<Community> {
    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  private async loadInviteContext(id: string): Promise<InviteContext> {
    const invite = await this.loadInviteOr404(id);
    const event = await this.events.findOne({ where: { id: invite.eventId } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const community = await this.loadGuestCommunityOr404(invite.communityId);
    return { invite, event, community };
  }

  private async communitiesByIds(
    ids: string[],
  ): Promise<Map<string, Community>> {
    const rows = await this.communities.find({
      where: { id: In([...new Set(ids)]) },
      select: { id: true, slug: true, name: true, accessTier: true },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }
}
