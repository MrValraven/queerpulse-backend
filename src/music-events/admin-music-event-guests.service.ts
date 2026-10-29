import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CheckInDto } from '../events/dto/check-in.dto';
import { CreateEventBanDto } from '../events/dto/create-event-ban.dto';
import { InviteEventDto } from '../events/dto/invite-event.dto';
import { ListAttendeesQuery } from '../events/dto/list-attendees.query';
import { EventBan } from '../events/entities/event-ban.entity';
import {
  EventInvite,
  EventInviteStatus,
} from '../events/entities/event-invite.entity';
import { EventBansService } from '../events/event-bans.service';
import {
  CheckInResultDTO,
  EventCheckInService,
} from '../events/event-check-in.service';
import { InviteRequestView } from '../events/event-invite-response';
import { EventInvitesService } from '../events/event-invites.service';
import { AttendeesPageDTO, EventBanView } from '../events/event-response';
import { EventsService } from '../events/events.service';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { MemberEventInvitesService } from '../events/member-event-invites.service';
import { RsvpService } from '../events/rsvp.service';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  HouseMusicEventScope,
  HouseMusicEventScopeService,
} from './house-music-event-scope.service';
import {
  MUSIC_EVENT_AUDIT_ACTIONS,
  MusicEventAuditAction,
  writeMusicEventAudit,
} from './music-event-audit';

export type InviteRequestDecision = 'approve' | 'decline';

/** The member an audit row names, or nothing when no profile matches. */
interface AuditTarget {
  targetUserId?: string;
  targetName?: string | null;
}

/**
 * The guest list, invites and door of an event QueerPulse hosts in Music.
 *
 * Every method loads the event through the house scope first, so a slug that
 * is not a house Music event answers 404 `music_event_not_found` before any
 * member service runs. The member services then act as the house account,
 * which is the host, so their organizer checks pass and their own refusals
 * keep their current bodies. Each write that changes something is audited
 * after it succeeds with the staff member as the actor. Door check-ins are not
 * audited (design).
 */
@Injectable()
export class AdminMusicEventGuestsService {
  constructor(
    private readonly scope: HouseMusicEventScopeService,
    private readonly eventsService: EventsService,
    private readonly rsvpService: RsvpService,
    private readonly eventBansService: EventBansService,
    private readonly eventInvitesService: EventInvitesService,
    private readonly memberEventInvitesService: MemberEventInvitesService,
    private readonly eventCheckInService: EventCheckInService,
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    @InjectRepository(EventBan)
    private readonly bans: Repository<EventBan>,
  ) {}

  /**
   * The organizer roster, read as the house. The door view calls this with
   * `status=going&arrival=&q=`, so the filters pass through unchanged. The
   * block filter runs against the house account (coordinator ruling).
   */
  async roster(
    slug: string,
    query: ListAttendeesQuery,
  ): Promise<AttendeesPageDTO> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.eventsService.attendees(
      slug,
      houseUserId,
      query.status ?? 'going',
      query.page,
      { arrival: query.arrival, q: query.q },
    );
  }

  async exportCsv(staffUserId: string, slug: string): Promise<string> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const csvBody = await this.eventsService.attendeesCsv(
      slug,
      scoped.houseUserId,
    );
    await this.audit(
      staffUserId,
      scoped,
      MUSIC_EVENT_AUDIT_ACTIONS.guestsExported,
    );
    return csvBody;
  }

  async promote(
    staffUserId: string,
    slug: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const result = await this.rsvpService.promoteAttendee(
      slug,
      scoped.houseUserId,
      memberSlug,
    );
    await this.audit(
      staffUserId,
      scoped,
      MUSIC_EVENT_AUDIT_ACTIONS.waitlistPromoted,
      await this.targetBySlug(memberSlug),
    );
    return result;
  }

  async removeGuest(
    staffUserId: string,
    slug: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const result = await this.rsvpService.removeAttendee(
      slug,
      scoped.houseUserId,
      memberSlug,
    );
    await this.audit(
      staffUserId,
      scoped,
      MUSIC_EVENT_AUDIT_ACTIONS.guestRemoved,
      await this.targetBySlug(memberSlug),
    );
    return result;
  }

  /**
   * The bar reason stays on the bar itself and never enters the audit row.
   * Barring a member who is already barred keeps the first bar and writes no
   * second row.
   */
  async bar(
    staffUserId: string,
    slug: string,
    dto: CreateEventBanDto,
  ): Promise<EventBanView> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const target = await this.targetBySlug(dto.memberSlug);
    const wasBarred = await this.isBarred(scoped, target);
    const barView = await this.eventBansService.ban(
      slug,
      scoped.houseUserId,
      dto.memberSlug,
      dto.reason,
    );
    if (!wasBarred) {
      await this.audit(
        staffUserId,
        scoped,
        MUSIC_EVENT_AUDIT_ACTIONS.guestBarred,
        target,
      );
    }
    return barView;
  }

  async listBars(slug: string): Promise<EventBanView[]> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.eventBansService.list(slug, houseUserId);
  }

  /** Lifting a bar that never existed succeeds and writes no audit row. */
  async liftBar(
    staffUserId: string,
    slug: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const target = await this.targetBySlug(memberSlug);
    const wasBarred = await this.isBarred(scoped, target);
    const result = await this.eventBansService.lift(
      slug,
      scoped.houseUserId,
      memberSlug,
    );
    if (wasBarred) {
      await this.audit(
        staffUserId,
        scoped,
        MUSIC_EVENT_AUDIT_ACTIONS.guestBarLifted,
        target,
      );
    }
    return result;
  }

  async sendInvites(
    staffUserId: string,
    slug: string,
    dto: InviteEventDto,
  ): Promise<{ created: number; alreadyInvited: string[] }> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const result = await this.eventInvitesService.createInvites(
      slug,
      scoped.houseUserId,
      dto.slugs,
    );
    await this.audit(
      staffUserId,
      scoped,
      MUSIC_EVENT_AUDIT_ACTIONS.invitesSent,
      {},
      `${result.created} sent`,
    );
    return result;
  }

  async listInviteRequests(slug: string): Promise<InviteRequestView[]> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.memberEventInvitesService.listRequests(slug, houseUserId);
  }

  /**
   * Approves or declines one invite request. An invite id that belongs to
   * another event answers 404 `music_event_invite_request_not_found` before
   * the member service runs, so the slug in the path always scopes the id.
   */
  async decideInviteRequest(
    staffUserId: string,
    slug: string,
    inviteId: string,
    decision: InviteRequestDecision,
  ): Promise<{ id: string; status: EventInviteStatus }> {
    const scoped = await this.scope.loadOrNotFound(slug);
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite || invite.eventId !== scoped.event.id) {
      throw houseMusicEventError('music_event_invite_request_not_found');
    }
    const result =
      decision === 'approve'
        ? await this.memberEventInvitesService.approve(
            inviteId,
            scoped.houseUserId,
          )
        : await this.memberEventInvitesService.declineRequest(
            inviteId,
            scoped.houseUserId,
          );
    await this.audit(
      staffUserId,
      scoped,
      MUSIC_EVENT_AUDIT_ACTIONS.inviteDecided,
      await this.targetByUserId(invite.inviteeId),
      decision,
    );
    return result;
  }

  /** Door check-in: no audit row (design). */
  async checkIn(slug: string, dto: CheckInDto): Promise<CheckInResultDTO> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.eventCheckInService.checkIn(slug, houseUserId, dto);
  }

  /** Undoing a door check-in: no audit row (design). */
  async undoCheckIn(
    slug: string,
    memberSlug: string,
  ): Promise<CheckInResultDTO> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.eventCheckInService.undoCheckIn(slug, houseUserId, memberSlug);
  }

  private async audit(
    staffUserId: string,
    scoped: HouseMusicEventScope,
    action: MusicEventAuditAction,
    target: AuditTarget = {},
    detail?: string,
  ): Promise<void> {
    await writeMusicEventAudit(this.auditLogs, {
      actorId: staffUserId,
      action,
      eventSlug: scoped.event.slug,
      eventTitle: scoped.event.title,
      ...target,
      detail,
    });
  }

  /** Whether the member already holds a bar on this event. A slug with no
   *  profile holds none, and the bans service answers its own 404. */
  private async isBarred(
    scoped: HouseMusicEventScope,
    target: AuditTarget,
  ): Promise<boolean> {
    if (target.targetUserId === undefined) return false;
    return this.bans.exists({
      where: { eventId: scoped.event.id, userId: target.targetUserId },
    });
  }

  private async targetBySlug(memberSlug: string): Promise<AuditTarget> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
      select: { userId: true, slug: true, firstName: true, lastName: true },
    });
    return toAuditTarget(profile);
  }

  private async targetByUserId(userId: string): Promise<AuditTarget> {
    const profile = await this.profiles.findOne({
      where: { userId },
      select: { userId: true, slug: true, firstName: true, lastName: true },
    });
    return toAuditTarget(profile);
  }
}

/**
 * A write-time snapshot of the member's display name, or their profile slug
 * when both names are blank. With no profile the row names no member, and the
 * audit subject falls back to the event title.
 */
function toAuditTarget(
  profile: Pick<Profile, 'userId' | 'slug' | 'firstName' | 'lastName'> | null,
): AuditTarget {
  if (!profile) return {};
  const displayName = `${profile.firstName} ${profile.lastName}`.trim();
  return {
    targetUserId: profile.userId,
    targetName: displayName.length > 0 ? displayName : profile.slug,
  };
}
