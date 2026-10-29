import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ChangeLineupRoleDto } from '../events/dto/change-lineup-role.dto';
import { CohostDto } from '../events/dto/cohost.dto';
import { CreateEventAnnouncementDto } from '../events/dto/create-event-announcement.dto';
import { CreateLineupInviteDto } from '../events/dto/create-lineup-invite.dto';
import { EventCohost } from '../events/entities/event-cohost.entity';
import type { Event } from '../events/entities/event.entity';
import { EventAnnouncementsService } from '../events/event-announcements.service';
import { EventLineupService } from '../events/event-lineup.service';
import type { GuestPreviewRole } from '../events/event-preview';
import {
  EventAnnouncementView,
  EventLineupDTO,
  EventOrganizerView,
  toOrganizerView,
} from '../events/event-response';
import { EventsService } from '../events/events.service';
import { houseMusicEventError } from '../events/house-music-event-errors';
import {
  cohostSeatRefusalFor,
  lockCohostSeatsForMember,
} from '../events/house-music-events';
import { HostConfigDto } from '../go-together/dto/host-config.dto';
import { GoTogetherHostService } from '../go-together/go-together-host.service';
import type {
  HostConfigResponse,
  HostSummaryResponse,
} from '../go-together/go-together-response';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { HouseMusicEventScopeService } from './house-music-event-scope.service';
import {
  MUSIC_EVENT_AUDIT_ACTIONS,
  type MusicEventAuditAction,
  writeMusicEventAudit,
} from './music-event-audit';
import { StudioArtistSearchService } from './studio-artist-search.service';

/** The member an audit row names, read from their profile. */
interface AuditMemberTarget {
  targetUserId: string;
  targetName: string;
}

/** The member's display name, or their profile slug when both names are
 *  blank, so a member target always carries a name. */
function memberNameOf(profile: Profile): string {
  const displayName = `${profile.firstName} ${profile.lastName}`.trim();
  return displayName.length > 0 ? displayName : profile.slug;
}

/**
 * Lineup, announcements, co-hosts and Go Together for events QueerPulse hosts
 * in Music. Every method loads the event through the house scope first, so a
 * member's own event answers `music_event_not_found` before any event
 * service runs. The member services then act as the house account, and each
 * write leaves one audit row naming the staff member.
 */
@Injectable()
export class AdminMusicEventProgramService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(EventCohost)
    private readonly cohostRepository: Repository<EventCohost>,
    @InjectRepository(Profile)
    private readonly profileRepository: Repository<Profile>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogRepository: Repository<ModAuditLog>,
    private readonly scope: HouseMusicEventScopeService,
    private readonly lineupService: EventLineupService,
    private readonly artistSearch: StudioArtistSearchService,
    private readonly announcementsService: EventAnnouncementsService,
    private readonly eventsService: EventsService,
    private readonly goTogetherHost: GoTogetherHostService,
  ) {}

  async lineup(
    slug: string,
    viewAs?: GuestPreviewRole,
  ): Promise<EventLineupDTO> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.lineupService.getLineup(slug, houseUserId, viewAs);
  }

  /**
   * Books a performer as the house: the invite comes from QueerPulse, and the
   * Studio artist rule runs against the staff member, so a block either way
   * with them refuses the booking.
   */
  async book(
    staffUserId: string,
    slug: string,
    dto: CreateLineupInviteDto,
  ): Promise<EventLineupDTO> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const lineup = await this.lineupService.inviteWithEligibilityCheck(
      slug,
      houseUserId,
      dto,
      (_eventId, inviteeUserId) =>
        this.artistSearch.assertBookable(staffUserId, inviteeUserId),
    );
    await this.auditMemberAction(
      staffUserId,
      event,
      MUSIC_EVENT_AUDIT_ACTIONS.lineupChanged,
      dto.memberSlug,
      `booked as ${dto.role}`,
    );
    return lineup;
  }

  async changeRole(
    staffUserId: string,
    slug: string,
    memberSlug: string,
    dto: ChangeLineupRoleDto,
  ): Promise<EventLineupDTO> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const lineup = await this.lineupService.changeRole(
      slug,
      houseUserId,
      memberSlug,
      dto.role,
    );
    await this.auditMemberAction(
      staffUserId,
      event,
      MUSIC_EVENT_AUDIT_ACTIONS.lineupChanged,
      memberSlug,
      `role ${dto.role}`,
    );
    return lineup;
  }

  async removePerformer(
    staffUserId: string,
    slug: string,
    memberSlug: string,
  ): Promise<EventLineupDTO> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const lineup = await this.lineupService.remove(
      slug,
      houseUserId,
      memberSlug,
    );
    await this.auditMemberAction(
      staffUserId,
      event,
      MUSIC_EVENT_AUDIT_ACTIONS.lineupChanged,
      memberSlug,
      'removed',
    );
    return lineup;
  }

  async announcements(slug: string): Promise<EventAnnouncementView[]> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.announcementsService.list(slug, houseUserId);
  }

  /** Posts as QueerPulse. The audit row records that a post went out and
   *  never stores its body. */
  async postAnnouncement(
    staffUserId: string,
    slug: string,
    dto: CreateEventAnnouncementDto,
  ): Promise<EventAnnouncementView> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const announcement = await this.announcementsService.create(
      slug,
      houseUserId,
      dto.body,
    );
    await writeMusicEventAudit(this.auditLogRepository, {
      actorId: staffUserId,
      action: MUSIC_EVENT_AUDIT_ACTIONS.announcementPosted,
      eventSlug: event.slug,
      eventTitle: event.title,
    });
    return announcement;
  }

  /** The co-hosts in seat order: oldest seat first, then by id. */
  async cohosts(slug: string): Promise<EventOrganizerView[]> {
    const { event } = await this.scope.loadOrNotFound(slug);
    const seats = await this.cohostRepository.find({
      where: { eventId: event.id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    if (seats.length === 0) return [];
    const profiles = await this.profileRepository.find({
      where: { userId: In(seats.map((seat) => seat.userId)) },
    });
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    const organizerViews: EventOrganizerView[] = [];
    for (const seat of seats) {
      const organizerView = toOrganizerView(profileByUserId.get(seat.userId));
      if (organizerView) organizerViews.push(organizerView);
    }
    return organizerViews;
  }

  /**
   * The direct add, so no invite reads as coming from QueerPulse. The seat
   * lock is taken before the refusals, so a grant given to the same member
   * cannot land between the check and the insert. The insert itself goes
   * through `EventsService.addCohostByUserId`, the single writer of
   * `event_cohosts`, on the same transaction as the audit row. The audit row
   * is written only when a new seat lands: a seat the member already held,
   * or the house account named as its own co-host, writes none.
   */
  async addCohost(
    staffUserId: string,
    slug: string,
    dto: CohostDto,
  ): Promise<{ ok: true }> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const profile = await this.profileRepository.findOne({
      where: { slug: dto.slug },
    });
    if (!profile) {
      throw houseMusicEventError('music_event_member_not_found');
    }
    const targetUserId = profile.userId;
    if (targetUserId === staffUserId) {
      throw houseMusicEventError('music_event_cohost_is_you');
    }
    await this.dataSource.transaction(async (manager) => {
      await lockCohostSeatsForMember(manager, targetUserId);
      const refusal = await cohostSeatRefusalFor(manager, targetUserId);
      if (refusal) throw houseMusicEventError(refusal);
      const targetUser = await manager
        .getRepository(User)
        .findOne({ where: { id: targetUserId } });
      if (targetUser?.status !== UserStatus.Active) {
        throw houseMusicEventError('music_event_cohost_not_active');
      }
      const isNewSeat =
        targetUserId !== houseUserId &&
        !(await manager.getRepository(EventCohost).exists({
          where: { eventId: event.id, userId: targetUserId },
        }));
      await this.eventsService.addCohostByUserId(
        event.id,
        targetUserId,
        manager,
      );
      if (!isNewSeat) return;
      await writeMusicEventAudit(manager.getRepository(ModAuditLog), {
        actorId: staffUserId,
        action: MUSIC_EVENT_AUDIT_ACTIONS.cohostAdded,
        eventSlug: event.slug,
        eventTitle: event.title,
        targetUserId,
        targetName: memberNameOf(profile),
      });
    });
    return { ok: true };
  }

  /** Removes the seat as the house. The audit row is written only when the
   *  member held a seat, so a repeated removal leaves no second row. */
  async removeCohost(
    staffUserId: string,
    slug: string,
    cohostSlug: string,
  ): Promise<{ ok: true }> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const profile = await this.profileRepository.findOne({
      where: { slug: cohostSlug },
    });
    const hasSeat = profile
      ? await this.cohostRepository.exists({
          where: { eventId: event.id, userId: profile.userId },
        })
      : false;
    await this.eventsService.removeCohost(slug, houseUserId, cohostSlug);
    if (profile && hasSeat) {
      await writeMusicEventAudit(this.auditLogRepository, {
        actorId: staffUserId,
        action: MUSIC_EVENT_AUDIT_ACTIONS.cohostRemoved,
        eventSlug: event.slug,
        eventTitle: event.title,
        targetUserId: profile.userId,
        targetName: memberNameOf(profile),
      });
    }
    return { ok: true };
  }

  async goTogetherConfig(slug: string): Promise<HostConfigResponse> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.goTogetherHost.getConfig(slug, houseUserId);
  }

  async saveGoTogetherConfig(
    staffUserId: string,
    slug: string,
    dto: HostConfigDto,
  ): Promise<HostConfigResponse> {
    const { event, houseUserId } = await this.scope.loadOrNotFound(slug);
    const config = await this.goTogetherHost.putConfig(slug, houseUserId, dto);
    await writeMusicEventAudit(this.auditLogRepository, {
      actorId: staffUserId,
      action: MUSIC_EVENT_AUDIT_ACTIONS.goTogetherChanged,
      eventSlug: event.slug,
      eventTitle: event.title,
      detail: `enabled ${dto.enabled}`,
    });
    return config;
  }

  async goTogetherSummary(slug: string): Promise<HostSummaryResponse> {
    const { houseUserId } = await this.scope.loadOrNotFound(slug);
    return this.goTogetherHost.summary(slug, houseUserId);
  }

  /** Writes one audit row naming the member behind `memberSlug`. The member
   *  service has already resolved the slug, so a missing profile only means
   *  it vanished since, and the row then names the event. */
  private async auditMemberAction(
    staffUserId: string,
    event: Event,
    action: MusicEventAuditAction,
    memberSlug: string,
    detail: string,
  ): Promise<void> {
    const profile = await this.profileRepository.findOne({
      where: { slug: memberSlug },
    });
    const target: Partial<AuditMemberTarget> = profile
      ? { targetUserId: profile.userId, targetName: memberNameOf(profile) }
      : {};
    await writeMusicEventAudit(this.auditLogRepository, {
      actorId: staffUserId,
      action,
      eventSlug: event.slug,
      eventTitle: event.title,
      ...target,
      detail,
    });
  }
}
