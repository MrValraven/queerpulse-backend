import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  CohostInviteDetailView,
  toCohostInviteDetailView,
} from './cohost-invite-response';
import { CreateCohostInviteDto } from './dto/create-cohost-invite.dto';
import {
  EventCohostInvite,
  EventCohostInviteStatus,
} from './entities/event-cohost-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EVENT_COHOST_INVITED, EventCohostInvitedEvent } from './event.events';
import { EventsService } from './events.service';

// Columns RETURNING (*) surfaces for a freshly-inserted invite row. Postgres
// returns snake_case columns here, mirroring EventInvitesService's
// InsertedInviteRow shape.
interface InsertedCohostInviteRow {
  id: string;
}

@Injectable()
export class EventCohostInvitesService {
  constructor(
    @InjectRepository(EventCohostInvite)
    private readonly invites: Repository<EventCohostInvite>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
    private readonly eventsService: EventsService,
    private readonly connectionsService: ConnectionsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createInvite(
    slug: string,
    inviterId: string,
    dto: CreateCohostInviteDto,
  ): Promise<{ id: string; status: EventCohostInviteStatus }> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (!(await this.eventsService.isOrganizer(event.id, inviterId))) {
      throw new ForbiddenException('Only the host or a co-host can invite');
    }
    const inviteeProfile = await this.profiles.findOne({
      where: { slug: dto.inviteeSlug },
    });
    if (!inviteeProfile) {
      throw new NotFoundException('Member not found');
    }
    if (inviteeProfile.userId === inviterId) {
      throw new BadRequestException('You cannot invite yourself');
    }
    const inviteeUser = await this.usersService.findById(inviteeProfile.userId);
    if (!inviteeUser || inviteeUser.status !== UserStatus.Active) {
      throw new BadRequestException('Co-hosts must be active members');
    }

    const result = await this.invites
      .createQueryBuilder()
      .insert()
      .into(EventCohostInvite)
      .values({
        eventId: event.id,
        inviterId,
        inviteeId: inviteeProfile.userId,
        role: dto.role,
        commitment: dto.commitment,
        message: dto.message ?? null,
        replyByDate: dto.replyByDate ? new Date(dto.replyByDate) : null,
        status: EventCohostInviteStatus.Pending,
      })
      .orIgnore()
      .returning('*')
      .execute();

    const insertedRows = (result.raw as InsertedCohostInviteRow[]) ?? [];
    const inserted = insertedRows[0];
    if (!inserted) {
      throw new ConflictException(
        'An invite is already pending for this member',
      );
    }

    this.eventEmitter.emit(EVENT_COHOST_INVITED, {
      eventId: event.id,
      eventSlug: event.slug,
      inviteId: inserted.id,
      inviterId,
      inviteeId: inviteeProfile.userId,
    } satisfies EventCohostInvitedEvent);

    return { id: inserted.id, status: EventCohostInviteStatus.Pending };
  }

  async getById(id: string, viewerId: string): Promise<CohostInviteDetailView> {
    const invite = await this.invites.findOne({ where: { id } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.inviterId !== viewerId && invite.inviteeId !== viewerId) {
      throw new ForbiddenException('This invite is not visible to you');
    }
    const event = await this.events.findOne({
      where: { id: invite.eventId },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const [
      inviter,
      goingCount,
      waitlistCount,
      mutualCounts,
      hostedEventsCount,
    ] = await Promise.all([
      this.profiles.findOne({ where: { userId: invite.inviterId } }),
      this.rsvps.count({
        where: { eventId: event.id, status: RsvpStatus.Going },
      }),
      this.rsvps.count({
        where: { eventId: event.id, status: RsvpStatus.Waitlisted },
      }),
      this.connectionsService.mutualCountsByUserIds(invite.inviteeId, [
        invite.inviterId,
      ]),
      this.events.count({
        where: { hostId: invite.inviterId, status: EventStatus.Published },
      }),
    ]);
    if (!inviter) {
      throw new NotFoundException('Inviter not found');
    }
    return toCohostInviteDetailView(
      invite,
      event,
      inviter,
      goingCount,
      waitlistCount,
      hostedEventsCount,
      mutualCounts.get(invite.inviterId) ?? 0,
    );
  }

  async respond(
    id: string,
    userId: string,
    action: 'accept' | 'decline',
  ): Promise<{ id: string; status: EventCohostInviteStatus }> {
    const invite = await this.invites.findOne({ where: { id } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.inviteeId !== userId) {
      throw new ForbiddenException('This invite is not addressed to you');
    }
    if (invite.status !== EventCohostInviteStatus.Pending) {
      throw new ConflictException('This invite has already been answered');
    }
    invite.status =
      action === 'accept'
        ? EventCohostInviteStatus.Accepted
        : EventCohostInviteStatus.Declined;
    // ONE transaction for both writes. Accepting used to save the invite and
    // then insert the roster row separately, so a failure in between left an
    // `accepted` invite with no `event_cohosts` row — and because a non-pending
    // invite 409s above, the invitee could never retry their way out of it.
    // The roster insert is idempotent (`orIgnore`), so a retry after a rollback
    // is safe.
    const saved = await this.invites.manager.transaction(async (manager) => {
      const persisted = await manager.save(EventCohostInvite, invite);
      if (action === 'accept') {
        await this.eventsService.addCohostByUserId(
          invite.eventId,
          invite.inviteeId,
          manager,
        );
      }
      return persisted;
    });
    return { id: saved.id, status: saved.status };
  }
}
