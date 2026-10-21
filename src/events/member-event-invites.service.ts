import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { EventAudienceGateService } from './event-audience-gate.service';
import {
  CreateMemberInvitesResult,
  InviteRequestView,
  InviterInviteView,
  MemberInviteRefusalReason,
  inviterFacingStatus,
  toInviteRequestView,
  toInviterInviteView,
} from './event-invite-response';
import { hasEnded } from './event-timing';
import {
  EVENT_INVITE_REQUEST_DECLINED,
  EVENT_INVITE_REQUESTED,
  EVENT_INVITED,
  EventInviteRequestDeclinedEvent,
  EventInviteRequestedEvent,
  EventInvitedEvent,
} from './event.events';
import { EventBan } from './entities/event-ban.entity';
import { EventCohost } from './entities/event-cohost.entity';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
  MEMBER_REINVITABLE_STATUSES,
  OPEN_MEMBER_INVITE_STATUSES,
} from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { EventsService } from './events.service';
import {
  MAX_RSVP_GUESTS,
  RSVP_GUEST_CAP_MESSAGE,
  assertRsvpsOpen,
} from './gathering-extras';

/**
 * The one reason every ineligible invitee is refused with. A non-connection,
 * a block in either direction (with the inviter or the host), a ban, a live
 * RSVP, a host removal, an earlier decline, an accepted invite later
 * cancelled, an audience miss, an inactive account and an unknown slug all
 * read the same, so an inviter can never probe who is attending, hidden,
 * blocked or saying no.
 */
const NOT_INVITABLE: MemberInviteRefusalReason = 'not_invitable';
const ALREADY_INVITED: MemberInviteRefusalReason = 'already_invited';

const ORGANISER_ONLY_MESSAGE = 'Only the host or a co-host can do that';
const INVITE_NOT_OPEN_MESSAGE = 'This invite is no longer open';

/**
 * Invite rows that block a new member invite with `already_invited`. An
 * accepted row is refused as not invitable before this is read: with a live
 * RSVP it is an attendee, and without one the invitee changed their mind.
 */
const ALREADY_INVITED_STATUSES: readonly EventInviteStatus[] = [
  ...OPEN_MEMBER_INVITE_STATUSES,
];

/** A requested invitee who passed every check, with the row to revive if any. */
interface EligibleInvitee {
  slug: string;
  inviteeId: string;
  existing: EventInvite | null;
}

// The columns RETURNING (*) surfaces for inserted invite rows, in Postgres's
// snake_case column names (the same shape `EventInvitesService` reads).
interface InsertedInviteRow {
  id: string;
  invitee_id: string;
  created_at: Date;
}

const REQUEST_NOT_APPROVABLE_MESSAGE = 'This request can no longer be approved';

/** What one create transaction announces once it has committed. */
interface CreatedInvitesOutcome {
  result: CreateMemberInvitesResult;
  invited: EventInvitedEvent[];
  requested: EventInviteRequestedEvent[];
}

/**
 * Member invites (2026-10-21 "bring connections to an event"): a member who
 * RSVPed going or maybe invites accepted connections, withdraws their own open
 * invites and reads them back with a server-computed status. Organisers list,
 * approve and decline the requests an `invite_only` event collects.
 *
 * Kept apart from `EventInvitesService` (host invites and the invitee's
 * accept) so neither grows the other's collaborators. Injects
 * `EventsService` one way only: nothing `EventsService` depends on injects
 * this service, so no cycle forms.
 */
@Injectable()
export class MemberEventInvitesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly eventsService: EventsService,
    private readonly audienceGate: EventAudienceGateService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Invites `inviteeSlugs` on behalf of `inviterId`. Runs in one transaction
   * holding the event's `pessimistic_write` lock, the same lock
   * `RsvpService.raiseGuestCountAndSave` takes, so a guest-count raise and an
   * invite created at the same moment cannot together pass the cap.
   */
  async createMemberInvites(
    slug: string,
    inviterId: string,
    inviteeSlugs: string[],
  ): Promise<CreateMemberInvitesResult> {
    const outcome = await this.dataSource.transaction((manager) =>
      this.createInManager(manager, slug, inviterId, inviteeSlugs),
    );
    for (const payload of outcome.invited) {
      this.eventEmitter.emit(EVENT_INVITED, payload);
    }
    for (const payload of outcome.requested) {
      this.eventEmitter.emit(EVENT_INVITE_REQUESTED, payload);
    }
    return outcome.result;
  }

  private async createInManager(
    manager: EntityManager,
    slug: string,
    inviterId: string,
    inviteeSlugs: string[],
  ): Promise<CreatedInvitesOutcome> {
    const event = await manager.findOne(Event, {
      where: { slug },
      lock: { mode: 'pessimistic_write' },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.status !== EventStatus.Published) {
      throw new BadRequestException('Only a published event can send invites');
    }
    if (hasEnded(event)) {
      throw new BadRequestException('This event has already happened');
    }
    const isOrganizer = await this.eventsService.isOrganizer(
      event.id,
      inviterId,
    );
    const inviterRsvp = await manager.findOne(EventRsvp, {
      where: { eventId: event.id, userId: inviterId },
    });
    const isInviterAttending =
      inviterRsvp?.status === RsvpStatus.Going ||
      inviterRsvp?.status === RsvpStatus.Maybe;
    if (!isOrganizer && !isInviterAttending) {
      throw new ForbiddenException(
        'RSVP going or maybe to invite your connections',
      );
    }
    if (!isOrganizer) {
      assertRsvpsOpen(event);
    }

    const requestedSlugs = [...new Set(inviteeSlugs)];
    const requestedProfiles = requestedSlugs.length
      ? await manager.find(Profile, { where: { slug: In(requestedSlugs) } })
      : [];
    // The cap is checked before any invitee is looked at, from the inviter's
    // own numbers and the slugs they sent. Checked after eligibility, a 400
    // for one slug would tell the inviter that person is invitable. The
    // inviter's own slug is left out of the count, since it reveals nothing
    // about anyone else.
    const selfSlugs = new Set(
      requestedProfiles
        .filter((profile) => profile.userId === inviterId)
        .map((profile) => profile.slug),
    );
    const requestedInviteeCount = requestedSlugs.filter(
      (requestedSlug) => !selfSlugs.has(requestedSlug),
    ).length;
    await this.assertWithinGuestCap(
      manager,
      event.id,
      inviterId,
      inviterRsvp?.guestCount ?? 0,
      requestedInviteeCount,
    );

    const userIdBySlug = await this.activeUserIdsBySlug(
      manager,
      requestedProfiles,
      inviterId,
    );
    const candidateIds = [...new Set(userIdBySlug.values())];
    const organiserIds = await this.organiserIds(manager, event);
    const ineligibleIds = await this.ineligibleInvitees(
      manager,
      event,
      inviterId,
      candidateIds,
      organiserIds,
    );
    const existingRows = candidateIds.length
      ? await manager.find(EventInvite, {
          where: { eventId: event.id, inviteeId: In(candidateIds) },
        })
      : [];
    const existingByInvitee = new Map(
      existingRows.map((row) => [row.inviteeId, row]),
    );

    const refused: CreateMemberInvitesResult['refused'] = [];
    const eligible: EligibleInvitee[] = [];
    for (const requestedSlug of requestedSlugs) {
      const inviteeId = userIdBySlug.get(requestedSlug);
      if (inviteeId === undefined || ineligibleIds.has(inviteeId)) {
        refused.push({ slug: requestedSlug, reason: NOT_INVITABLE });
        continue;
      }
      const existing = existingByInvitee.get(inviteeId) ?? null;
      // An accepted invite whose invitee holds no live RSVP (a live one is
      // already refused above) means they said yes and then cancelled. That
      // reads like a decline, so a second inviter cannot tell the two apart.
      if (existing?.status === EventInviteStatus.Accepted) {
        refused.push({ slug: requestedSlug, reason: NOT_INVITABLE });
        continue;
      }
      if (existing && ALREADY_INVITED_STATUSES.includes(existing.status)) {
        refused.push({ slug: requestedSlug, reason: ALREADY_INVITED });
        continue;
      }
      // A member may only reuse a withdrawn or host-declined row. Every other
      // ended row (an earlier decline) keeps the invitee's no, and reads as
      // not invitable like every other refusal.
      if (existing && !MEMBER_REINVITABLE_STATUSES.includes(existing.status)) {
        refused.push({ slug: requestedSlug, reason: NOT_INVITABLE });
        continue;
      }
      eligible.push({ slug: requestedSlug, inviteeId, existing });
    }
    if (!eligible.length) {
      return { result: { invites: [], refused }, invited: [], requested: [] };
    }

    const status =
      event.visibility === EventVisibility.InviteOnly && !isOrganizer
        ? EventInviteStatus.AwaitingHost
        : EventInviteStatus.Pending;
    const written = await this.writeInvites(
      manager,
      event.id,
      inviterId,
      status,
      eligible,
    );
    for (const lostSlug of written.lostSlugs) {
      refused.push({ slug: lostSlug, reason: ALREADY_INVITED });
    }
    const saved = written.rows;
    if (!saved.length) {
      return { result: { invites: [], refused }, invited: [], requested: [] };
    }

    const profileByUserId = new Map(
      requestedProfiles.map((profile) => [profile.userId, profile]),
    );
    const viewStatus =
      status === EventInviteStatus.AwaitingHost ? 'awaiting_host' : 'invited';
    const invites = saved.map((row) =>
      toInviterInviteView(row, viewStatus, profileByUserId.get(row.inviteeId)),
    );

    if (status === EventInviteStatus.Pending) {
      return {
        result: { invites, refused },
        invited: saved.map((row) => ({
          eventId: event.id,
          eventSlug: event.slug,
          inviteId: row.id,
          inviterId,
          inviteeId: row.inviteeId,
        })),
        requested: [],
      };
    }
    return {
      result: { invites, refused },
      invited: [],
      requested: saved.map((row) => ({
        eventId: event.id,
        eventSlug: event.slug,
        eventTitle: event.title,
        inviteId: row.id,
        inviterId,
        inviteeId: row.inviteeId,
        organiserIds,
      })),
    };
  }

  /**
   * Powers GET /events/:slug/rsvp/invites: the caller's own member invites to
   * one event, newest first, each with the status `inviterFacingStatus`
   * computes. Withdrawn invites and invitees blocked either way are left out.
   */
  async listMyInvites(
    slug: string,
    inviterId: string,
  ): Promise<InviterInviteView[]> {
    const { event } = await this.findViewableEventBySlug(slug, inviterId);
    const rows = await this.invites.find({
      where: {
        eventId: event.id,
        inviterId,
        source: EventInviteSource.Member,
      },
      order: { createdAt: 'DESC' },
    });
    const listedRows = rows.filter(
      (row) => row.status !== EventInviteStatus.Withdrawn,
    );
    if (!listedRows.length) {
      return [];
    }
    const inviteeIds = listedRows.map((row) => row.inviteeId);
    const [blockedIds, connectedIds, inviteeRsvps, inviteeProfiles] =
      await Promise.all([
        this.blockFilter.blockedUserIds(inviterId, inviteeIds),
        this.connectionsService.acceptedConnectionsAmong(inviterId, inviteeIds),
        this.rsvps.find({
          where: { eventId: event.id, userId: In(inviteeIds) },
        }),
        this.profiles.find({ where: { userId: In(inviteeIds) } }),
      ]);
    const rsvpByUserId = new Map(inviteeRsvps.map((row) => [row.userId, row]));
    const profileByUserId = new Map(
      inviteeProfiles.map((profile) => [profile.userId, profile]),
    );
    const views: InviterInviteView[] = [];
    for (const row of listedRows) {
      if (blockedIds.has(row.inviteeId)) continue;
      const inviteeRsvp = rsvpByUserId.get(row.inviteeId);
      const status = inviterFacingStatus(
        row.status,
        inviteeRsvp
          ? { status: inviteeRsvp.status, visibility: inviteeRsvp.visibility }
          : null,
        connectedIds.has(row.inviteeId),
      );
      if (status === null) continue;
      views.push(
        toInviterInviteView(row, status, profileByUserId.get(row.inviteeId)),
      );
    }
    return views;
  }

  /**
   * Powers GET /events/:slug/invite-requests: member invites on this event
   * still waiting for an organiser, oldest first. Organisers only.
   */
  async listRequests(
    slug: string,
    userId: string,
  ): Promise<InviteRequestView[]> {
    const { event, isOrganizer } = await this.findViewableEventBySlug(
      slug,
      userId,
    );
    if (!isOrganizer) {
      throw new ForbiddenException(ORGANISER_ONLY_MESSAGE);
    }
    const rows = await this.invites.find({
      where: { eventId: event.id, status: EventInviteStatus.AwaitingHost },
      order: { createdAt: 'ASC' },
    });
    if (!rows.length) {
      return [];
    }
    const userIds = [
      ...new Set(rows.flatMap((row) => [row.inviterId, row.inviteeId])),
    ];
    const userProfiles = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    const profileByUserId = new Map(
      userProfiles.map((profile) => [profile.userId, profile]),
    );
    return rows.map((row) =>
      toInviteRequestView(
        row,
        profileByUserId.get(row.inviterId),
        profileByUserId.get(row.inviteeId),
      ),
    );
  }

  /** The inviter takes back an invite that is still pending or awaiting a host. */
  async withdraw(
    inviteId: string,
    userId: string,
  ): Promise<{ id: string; status: EventInviteStatus }> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    // Someone else's invite reads as missing, so an id says nothing about
    // whether it exists.
    if (
      !invite ||
      invite.inviterId !== userId ||
      invite.source !== EventInviteSource.Member
    ) {
      throw new NotFoundException('Invite not found');
    }
    const result = await this.invites
      .createQueryBuilder()
      .update(EventInvite)
      .set({ status: EventInviteStatus.Withdrawn })
      .where('id = :inviteId', { inviteId })
      .andWhere('inviter_id = :userId', { userId })
      .andWhere('source = :member', { member: EventInviteSource.Member })
      .andWhere('status IN (:...openStatuses)', {
        openStatuses: [...OPEN_MEMBER_INVITE_STATUSES],
      })
      .execute();
    if (!result.affected) {
      throw new ConflictException(INVITE_NOT_OPEN_MESSAGE);
    }
    return { id: invite.id, status: EventInviteStatus.Withdrawn };
  }

  /** An organiser lets a member's request through, which notifies the invitee. */
  async approve(
    inviteId: string,
    userId: string,
  ): Promise<{ id: string; status: EventInviteStatus }> {
    const invite = await this.findInvite(inviteId);
    await this.assertOrganizer(invite.eventId, userId);
    const event = await this.events.findOne({ where: { id: invite.eventId } });
    // Re-checked at approval, since the request may have waited a while: the
    // event must still be live, and the invitee still active, unbanned and
    // unblocked with both the inviter and the host. A failed re-check is one
    // neutral 409 that moves nothing and notifies nobody.
    if (!event || !(await this.isStillApprovable(event, invite))) {
      throw new ConflictException(REQUEST_NOT_APPROVABLE_MESSAGE);
    }
    await this.moveRequest(inviteId, EventInviteStatus.Pending);
    this.eventEmitter.emit(EVENT_INVITED, {
      eventId: event.id,
      eventSlug: event.slug,
      inviteId: invite.id,
      inviterId: invite.inviterId,
      inviteeId: invite.inviteeId,
    } satisfies EventInvitedEvent);
    return { id: invite.id, status: EventInviteStatus.Pending };
  }

  /** An organiser turns a member's request down, which tells the inviter. */
  async declineRequest(
    inviteId: string,
    userId: string,
  ): Promise<{ id: string; status: EventInviteStatus }> {
    const invite = await this.findInvite(inviteId);
    await this.assertOrganizer(invite.eventId, userId);
    await this.moveRequest(inviteId, EventInviteStatus.HostDeclined);
    const event = await this.events.findOne({ where: { id: invite.eventId } });
    if (event) {
      this.eventEmitter.emit(EVENT_INVITE_REQUEST_DECLINED, {
        eventId: event.id,
        eventSlug: event.slug,
        eventTitle: event.title,
        inviteId: invite.id,
        inviterId: invite.inviterId,
      } satisfies EventInviteRequestDeclinedEvent);
    }
    return { id: invite.id, status: EventInviteStatus.HostDeclined };
  }

  // --- internals ---

  /**
   * The guest cap: the inviter's unnamed guests plus every open member invite
   * they hold plus the invitees they asked for now. A saved count already
   * above the cap leaves no room for an invite.
   */
  private async assertWithinGuestCap(
    manager: EntityManager,
    eventId: string,
    inviterId: string,
    guestCount: number,
    requestedInviteeCount: number,
  ): Promise<void> {
    if (!requestedInviteeCount) {
      return;
    }
    const openInviteCount = await manager.count(EventInvite, {
      where: {
        eventId,
        inviterId,
        source: EventInviteSource.Member,
        status: In(OPEN_MEMBER_INVITE_STATUSES),
      },
    });
    if (
      guestCount + openInviteCount + requestedInviteeCount >
      MAX_RSVP_GUESTS
    ) {
      throw new BadRequestException(RSVP_GUEST_CAP_MESSAGE);
    }
  }

  /**
   * Requested slug to user id, for active accounts only and never the
   * inviter. A slug missing from the map is refused as not invitable.
   */
  private async activeUserIdsBySlug(
    manager: EntityManager,
    requestedProfiles: Profile[],
    inviterId: string,
  ): Promise<Map<string, string>> {
    const userIdBySlug = new Map<string, string>();
    const candidates = requestedProfiles.filter(
      (profile) => profile.userId !== inviterId,
    );
    if (!candidates.length) {
      return userIdBySlug;
    }
    const activeUsers = await manager.find(User, {
      where: {
        id: In(candidates.map((profile) => profile.userId)),
        status: UserStatus.Active,
      },
      select: { id: true },
    });
    const activeIds = new Set(activeUsers.map((user) => user.id));
    for (const profile of candidates) {
      if (activeIds.has(profile.userId)) {
        userIdBySlug.set(profile.slug, profile.userId);
      }
    }
    return userIdBySlug;
  }

  /**
   * Revives the reusable rows and inserts the rest. Both writes are
   * conditional, mirroring the host path in `EventInvitesService`: a revive
   * lands only on a row still withdrawn or host-declined, and an insert that
   * meets an existing row is skipped. A row lost either way reads as already
   * invited. A revived row takes a fresh `createdAt`, so it sorts and dates
   * as the new invite it is.
   */
  private async writeInvites(
    manager: EntityManager,
    eventId: string,
    inviterId: string,
    status: EventInviteStatus,
    eligible: EligibleInvitee[],
  ): Promise<{ rows: EventInvite[]; lostSlugs: string[] }> {
    const rows: EventInvite[] = [];
    const lostSlugs: string[] = [];
    const revivedAt = new Date();
    for (const { slug, existing } of eligible) {
      if (!existing) continue;
      const revived = await manager
        .createQueryBuilder()
        .update(EventInvite)
        .set({
          inviterId,
          source: EventInviteSource.Member,
          status,
          createdAt: revivedAt,
        })
        .where('id = :inviteId', { inviteId: existing.id })
        .andWhere('status IN (:...reinvitableStatuses)', {
          reinvitableStatuses: [...MEMBER_REINVITABLE_STATUSES],
        })
        .execute();
      if (!revived.affected) {
        lostSlugs.push(slug);
        continue;
      }
      rows.push({
        ...existing,
        inviterId,
        source: EventInviteSource.Member,
        status,
        createdAt: revivedAt,
      });
    }

    const fresh = eligible.filter(({ existing }) => existing === null);
    if (!fresh.length) {
      return { rows, lostSlugs };
    }
    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(EventInvite)
      .values(
        fresh.map(({ inviteeId }) => ({
          eventId,
          inviterId,
          inviteeId,
          source: EventInviteSource.Member,
          status,
        })),
      )
      .orIgnore()
      .returning('*')
      .execute();
    const insertedRows = (inserted.raw as InsertedInviteRow[]) ?? [];
    const insertedByInvitee = new Map(
      insertedRows.map((row) => [row.invitee_id, row]),
    );
    for (const { slug, inviteeId } of fresh) {
      const row = insertedByInvitee.get(inviteeId);
      if (!row) {
        lostSlugs.push(slug);
        continue;
      }
      rows.push({
        id: row.id,
        eventId,
        inviterId,
        inviteeId,
        source: EventInviteSource.Member,
        status,
        createdAt: row.created_at,
      });
    }
    return { rows, lostSlugs };
  }

  /**
   * Whether an `awaiting_host` request may still turn into an invite: the
   * event is published and has not ended, and the invitee is active, not
   * banned, holds no live RSVP (they may have RSVPed while the request
   * waited), and is not blocked either way with the inviter or the host.
   */
  private async isStillApprovable(
    event: Event,
    invite: EventInvite,
  ): Promise<boolean> {
    if (event.status !== EventStatus.Published || hasEnded(event)) {
      return false;
    }
    const inviteeIds = [invite.inviteeId];
    const [
      isActive,
      isBanned,
      isAttending,
      blockedWithInviter,
      blockedWithHost,
    ] = await Promise.all([
      this.dataSource.manager.exists(User, {
        where: { id: invite.inviteeId, status: UserStatus.Active },
      }),
      this.dataSource.manager.exists(EventBan, {
        where: { eventId: event.id, userId: invite.inviteeId },
      }),
      this.dataSource.manager.exists(EventRsvp, {
        where: {
          eventId: event.id,
          userId: invite.inviteeId,
          status: Not(RsvpStatus.Cancelled),
        },
      }),
      this.blockFilter.blockedUserIds(invite.inviterId, inviteeIds),
      event.hostId !== null
        ? this.blockFilter.blockedUserIds(event.hostId, inviteeIds)
        : Promise.resolve(new Set<string>()),
    ]);
    return (
      isActive &&
      !isBanned &&
      !isAttending &&
      !blockedWithInviter.has(invite.inviteeId) &&
      !blockedWithHost.has(invite.inviteeId)
    );
  }

  /**
   * The candidates nobody may invite, every reason folded into one set so
   * the caller cannot tell them apart: an organiser of the event, a
   * candidate with no accepted connection to the inviter, a block either way with the inviter or the host, a ban, a live
   * RSVP, a host removal, or outside the event's audience (checked for every
   * audience except `invite_only`, which takes the approval route instead).
   * An earlier decline is caught from the invite row by the caller.
   */
  private async ineligibleInvitees(
    manager: EntityManager,
    event: Event,
    inviterId: string,
    candidateIds: string[],
    organiserIds: string[],
  ): Promise<Set<string>> {
    if (!candidateIds.length) {
      return new Set();
    }
    const hostId =
      event.hostId !== null && event.hostId !== inviterId ? event.hostId : null;
    const [
      connectedIds,
      blockedWithInviter,
      blockedWithHost,
      bans,
      candidateRsvps,
      audience,
    ] = await Promise.all([
      this.connectionsService.acceptedConnectionsAmong(inviterId, candidateIds),
      this.blockFilter.blockedUserIds(inviterId, candidateIds),
      hostId !== null
        ? this.blockFilter.blockedUserIds(hostId, candidateIds)
        : Promise.resolve(new Set<string>()),
      manager.find(EventBan, {
        where: { eventId: event.id, userId: In(candidateIds) },
        select: { userId: true },
      }),
      manager.find(EventRsvp, {
        where: { eventId: event.id, userId: In(candidateIds) },
      }),
      event.visibility === EventVisibility.InviteOnly
        ? Promise.resolve(null)
        : this.audienceGate.audienceAmong(event, candidateIds),
    ]);
    // The host and co-hosts are already on the event, so a member invite to
    // them is refused like every other ineligible invitee.
    const organiserIdSet = new Set(organiserIds);
    const ineligible = new Set<string>();
    for (const candidateId of candidateIds) {
      if (organiserIdSet.has(candidateId)) {
        ineligible.add(candidateId);
        continue;
      }
      if (
        !connectedIds.has(candidateId) ||
        blockedWithInviter.has(candidateId) ||
        blockedWithHost.has(candidateId) ||
        (audience !== null && !audience.viewerUserIds.has(candidateId))
      ) {
        ineligible.add(candidateId);
      }
    }
    for (const ban of bans) {
      ineligible.add(ban.userId);
    }
    for (const rsvp of candidateRsvps) {
      if (rsvp.status !== RsvpStatus.Cancelled || rsvp.removedByHostAt) {
        ineligible.add(rsvp.userId);
      }
    }
    return ineligible;
  }

  /** The host plus every co-host, the recipients of a new request. */
  private async organiserIds(
    manager: EntityManager,
    event: Event,
  ): Promise<string[]> {
    const cohosts = await manager.find(EventCohost, {
      where: { eventId: event.id },
      select: { userId: true },
    });
    const ids = new Set(cohosts.map((cohost) => cohost.userId));
    if (event.hostId !== null) {
      ids.add(event.hostId);
    }
    return [...ids];
  }

  /** Moves an `awaiting_host` request on; a request already decided is a 409. */
  private async moveRequest(
    inviteId: string,
    status: EventInviteStatus.Pending | EventInviteStatus.HostDeclined,
  ): Promise<void> {
    const result = await this.invites
      .createQueryBuilder()
      .update(EventInvite)
      .set({ status })
      .where('id = :inviteId', { inviteId })
      .andWhere('status IN (:...awaitingStatuses)', {
        awaitingStatuses: [EventInviteStatus.AwaitingHost],
      })
      .execute();
    if (!result.affected) {
      throw new ConflictException(INVITE_NOT_OPEN_MESSAGE);
    }
  }

  private async assertOrganizer(
    eventId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.eventsService.isOrganizer(eventId, userId))) {
      throw new ForbiddenException(ORGANISER_ONLY_MESSAGE);
    }
  }

  /**
   * The event behind `slug`, read only by someone its audience rules let see
   * it. An event the caller cannot see (an `invite_only` event they were
   * never invited to, say) answers the same 404 as a missing slug, so these
   * routes never confirm that a hidden event exists.
   */
  private async findViewableEventBySlug(
    slug: string,
    userId: string,
  ): Promise<{ event: Event; isOrganizer: boolean }> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const isOrganizer = await this.eventsService.isOrganizer(event.id, userId);
    await this.audienceGate.assertViewable(event, userId, isOrganizer);
    return { event, isOrganizer };
  }

  private async findInvite(inviteId: string): Promise<EventInvite> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    return invite;
  }
}
