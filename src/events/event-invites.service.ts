import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { EventInvite, EventInviteStatus } from './entities/event-invite.entity';
import { Event } from './entities/event.entity';
import { EventsService } from './events.service';
import { EVENT_INVITED, EventInvitedEvent } from './event.events';

@Injectable()
export class EventInvitesService {
  constructor(
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly eventsService: EventsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createInvites(
    slug: string,
    inviterId: string,
    inviteeSlugs: string[],
  ): Promise<{ created: number }> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (!(await this.eventsService.isOrganizer(event.id, inviterId))) {
      throw new ForbiddenException('Only the host or a co-host can invite');
    }
    const profiles = await this.profiles.find({
      where: { slug: In(inviteeSlugs) },
    });
    let created = 0;
    for (const profile of profiles) {
      if (profile.userId === inviterId) {
        continue;
      }
      const exists = await this.invites.exists({
        where: { eventId: event.id, inviteeId: profile.userId },
      });
      if (exists) {
        continue;
      }
      await this.invites.save(
        this.invites.create({
          eventId: event.id,
          inviterId,
          inviteeId: profile.userId,
          status: EventInviteStatus.Pending,
        }),
      );
      created += 1;
      this.eventEmitter.emit(EVENT_INVITED, {
        eventId: event.id,
        inviterId,
        inviteeId: profile.userId,
      } satisfies EventInvitedEvent);
    }
    return { created };
  }

  async respondInvite(
    inviteId: string,
    userId: string,
    action: 'accept' | 'decline',
  ): Promise<EventInvite> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.inviteeId !== userId) {
      throw new ForbiddenException('This invite is not addressed to you');
    }
    if (invite.status !== EventInviteStatus.Pending) {
      throw new ConflictException('This invite has already been answered');
    }
    invite.status =
      action === 'accept'
        ? EventInviteStatus.Accepted
        : EventInviteStatus.Declined;
    return this.invites.save(invite);
  }
}
