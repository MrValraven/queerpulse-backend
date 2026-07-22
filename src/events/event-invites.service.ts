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
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  PendingEventInviteView,
  toPendingEventInviteView,
} from './event-invite-response';
import { EventInvite, EventInviteStatus } from './entities/event-invite.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventsService } from './events.service';
import { EVENT_INVITED, EventInvitedEvent } from './event.events';

// The columns RETURNING (*) surfaces for freshly-inserted invite rows. Postgres
// returns default (snake_case) column names, so we read invitee_id, not the
// camelCase entity property.
interface InsertedInviteRow {
  id: string;
  invitee_id: string;
}

@Injectable()
export class EventInvitesService {
  constructor(
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
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
    // Draft/cancelled events cannot recruit attendees — only published ones.
    if (event.status !== EventStatus.Published) {
      throw new BadRequestException('Only a published event can send invites');
    }
    if (!(await this.eventsService.isOrganizer(event.id, inviterId))) {
      throw new ForbiddenException('Only the host or a co-host can invite');
    }

    // Resolve slugs → user ids, dropping the inviter inviting themselves.
    const profiles = await this.profiles.find({
      where: { slug: In(inviteeSlugs) },
    });
    const candidateIds = profiles
      .map((p) => p.userId)
      .filter((id) => id !== inviterId);
    if (!candidateIds.length) {
      return { created: 0 };
    }

    // Only active members are invitable — pending/suspended accounts are skipped.
    const activeUsers = await this.users.find({
      where: { id: In(candidateIds), status: UserStatus.Active },
      select: { id: true },
    });
    const activeIds = activeUsers.map((u) => u.id);
    if (!activeIds.length) {
      return { created: 0 };
    }

    // Bulk insert, letting the unique (event_id, invitee_id) constraint skip
    // anyone already invited (ON CONFLICT DO NOTHING). RETURNING gives us only
    // the rows that were actually inserted, so we notify exactly those invitees.
    const result = await this.invites
      .createQueryBuilder()
      .insert()
      .into(EventInvite)
      .values(
        activeIds.map((inviteeId) => ({
          eventId: event.id,
          inviterId,
          inviteeId,
          status: EventInviteStatus.Pending,
        })),
      )
      .orIgnore()
      .returning('*')
      .execute();

    const insertedRows = (result.raw as InsertedInviteRow[]) ?? [];
    for (const row of insertedRows) {
      this.eventEmitter.emit(EVENT_INVITED, {
        eventId: event.id,
        inviteId: row.id,
        inviterId,
        inviteeId: row.invitee_id,
      } satisfies EventInvitedEvent);
    }
    return { created: insertedRows.length };
  }

  // Powers GET /event-invites — the viewer's still-pending event invites, each
  // carrying the invite id (for PATCH /event-invites/:id) plus enough event and
  // inviter context to render a decision card.
  async listMyPendingInvites(
    userId: string,
  ): Promise<PendingEventInviteView[]> {
    const invites = await this.invites.find({
      where: { inviteeId: userId, status: EventInviteStatus.Pending },
      order: { createdAt: 'DESC' },
    });
    if (!invites.length) {
      return [];
    }
    const eventIds = invites.map((i) => i.eventId);
    const inviterIds = invites.map((i) => i.inviterId);
    const [events, profiles] = await Promise.all([
      this.events.find({ where: { id: In(eventIds) } }),
      this.profiles.find({ where: { userId: In(inviterIds) } }),
    ]);
    const eventsById = new Map(events.map((e) => [e.id, e]));
    const profilesByUserId = new Map(profiles.map((p) => [p.userId, p]));
    return invites.map((invite) =>
      toPendingEventInviteView(
        invite,
        eventsById.get(invite.eventId) ?? null,
        profilesByUserId.get(invite.inviterId),
      ),
    );
  }

  async respondInvite(
    inviteId: string,
    userId: string,
    action: 'accept' | 'decline',
  ): Promise<{ id: string; status: EventInviteStatus }> {
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
    // Return only what the client needs (the new status), not the raw entity —
    // which would leak `inviterId`/`inviteeId`/`eventId` internal columns.
    const saved = await this.invites.save(invite);
    return { id: saved.id, status: saved.status };
  }
}
