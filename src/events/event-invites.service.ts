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
import { AcceptInviteDetailsDto } from './dto/accept-invite-details.dto';
import {
  PendingEventInviteView,
  toPendingEventInviteView,
} from './event-invite-response';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
  HOST_REVIVABLE_STATUSES,
} from './entities/event-invite.entity';
import { RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventsService } from './events.service';
import { EVENT_INVITED, EventInvitedEvent } from './event.events';
import { assertRsvpsOpen } from './gathering-extras';
import { RsvpResult, RsvpService } from './rsvp.service';

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
    // Accepting an invite is an RSVP: `acceptInviteRsvp` takes the seat,
    // saves the invitee's details and flips the invite in one transaction.
    private readonly rsvpService: RsvpService,
  ) {}

  async createInvites(
    slug: string,
    inviterId: string,
    inviteeSlugs: string[],
  ): Promise<{ created: number; alreadyInvited: string[] }> {
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
      return { created: 0, alreadyInvited: [] };
    }

    // Only active members are invitable — pending/suspended accounts are skipped.
    const activeUsers = await this.users.find({
      where: { id: In(candidateIds), status: UserStatus.Active },
      select: { id: true },
    });
    const activeIds = activeUsers.map((u) => u.id);
    if (!activeIds.length) {
      return { created: 0, alreadyInvited: [] };
    }

    // Bulk insert, letting the unique (event_id, invitee_id) constraint skip
    // anyone who already has a row (ON CONFLICT DO NOTHING). RETURNING gives
    // us only the rows that were actually inserted; the skipped ones are
    // revived or reported below.
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
    const insertedInviteeIds = new Set(
      insertedRows.map((row) => row.invitee_id),
    );
    const conflictingIds = activeIds.filter(
      (inviteeId) => !insertedInviteeIds.has(inviteeId),
    );
    const revivedRows = await this.reviveEndedInvites(
      event.id,
      inviterId,
      conflictingIds,
    );
    const revivedInviteeIds = new Set(revivedRows.map((row) => row.invitee_id));

    for (const row of [...insertedRows, ...revivedRows]) {
      this.eventEmitter.emit(EVENT_INVITED, {
        eventId: event.id,
        eventSlug: event.slug,
        inviteId: row.id,
        inviterId,
        inviteeId: row.invitee_id,
      } satisfies EventInvitedEvent);
    }

    // Everyone else who hit the constraint still holds an open or accepted
    // invite, so the host is told they are already invited.
    const slugsByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile.slug]),
    );
    const alreadyInvited = conflictingIds
      .filter((inviteeId) => !revivedInviteeIds.has(inviteeId))
      .map((inviteeId) => slugsByUserId.get(inviteeId))
      .filter((inviteeSlug): inviteeSlug is string => Boolean(inviteeSlug));

    return {
      created: insertedRows.length + revivedRows.length,
      alreadyInvited,
    };
  }

  // A host may invite again anyone whose invite has ended (they declined, the
  // member who invited them withdrew, or a host turned the request down), and
  // anyone who accepted but no longer holds a live RSVP (they cancelled, or
  // never had one). The row is reused as a fresh pending host invite with a
  // new `createdAt`, so it sorts as the new invite it is, and the unique
  // (event_id, invitee_id) constraint keeps one invite per person. The status
  // and RSVP guards sit in the UPDATE itself, so a row that reopened, or an
  // invitee who RSVPed, since it was read is left alone and reported as
  // already invited.
  private async reviveEndedInvites(
    eventId: string,
    inviterId: string,
    conflictingIds: string[],
  ): Promise<InsertedInviteRow[]> {
    if (!conflictingIds.length) {
      return [];
    }
    const conflictingRows = await this.invites.find({
      where: { eventId, inviteeId: In(conflictingIds) },
      select: { id: true, inviteeId: true, status: true },
    });
    const revivableIds = conflictingRows
      .filter(
        (row) =>
          HOST_REVIVABLE_STATUSES.includes(row.status) ||
          row.status === EventInviteStatus.Accepted,
      )
      .map((row) => row.id);
    if (!revivableIds.length) {
      return [];
    }
    const result = await this.invites
      .createQueryBuilder()
      .update(EventInvite)
      .set({
        status: EventInviteStatus.Pending,
        inviterId,
        source: EventInviteSource.Host,
        createdAt: new Date(),
      })
      .where(
        'id IN (:...revivableIds) AND (status IN (:...revivableStatuses) OR ' +
          '(status = :acceptedStatus AND NOT EXISTS (SELECT 1 FROM event_rsvps r ' +
          'WHERE r.event_id = event_invites.event_id ' +
          'AND r.user_id = event_invites.invitee_id ' +
          'AND r.status <> :cancelledStatus)))',
        {
          revivableIds,
          revivableStatuses: [...HOST_REVIVABLE_STATUSES],
          acceptedStatus: EventInviteStatus.Accepted,
          cancelledStatus: RsvpStatus.Cancelled,
        },
      )
      .returning('*')
      .execute();
    return (result.raw as InsertedInviteRow[]) ?? [];
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
    return (
      invites
        // A cancelled gathering's invite is not a decision anyone still has to
        // make (PRD-185). It used to stay in the list looking answerable: the
        // invitee was never told the gathering was off, accepting it was not
        // refused, and the follow-up RSVP then failed with a 400 they had no
        // way to read. `EventsService.cancel` now notifies pending invitees;
        // this stops the stale row from sitting in their list either way.
        // An invite whose event row has gone entirely is dropped for the same
        // reason — there is nothing left to accept.
        .filter((invite) => {
          const event = eventsById.get(invite.eventId);
          return event !== undefined && event.status !== EventStatus.Cancelled;
        })
        .map((invite) =>
          toPendingEventInviteView(
            invite,
            eventsById.get(invite.eventId) ?? null,
            profilesByUserId.get(invite.inviterId),
          ),
        )
    );
  }

  async respondInvite(
    inviteId: string,
    userId: string,
    action: 'accept' | 'decline',
    details?: AcceptInviteDetailsDto,
  ): Promise<{
    id: string;
    status: EventInviteStatus;
    rsvp: RsvpResult | null;
  }> {
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
    // Accepting a cancelled gathering is not a thing that can happen (PRD-185).
    // It used to be allowed: the invite flipped to `accepted`, the client then
    // called RSVP, and the RSVP answered 400 "Event is not open for RSVPs" —
    // an error about a state nothing had told the invitee about. Refused here,
    // in words that name the actual reason. DECLINING stays allowed: clearing
    // a dead invite off your own list is always yours to do.
    if (action === 'accept') {
      const event = await this.events.findOne({
        where: { id: invite.eventId },
      });
      if (!event || event.status === EventStatus.Cancelled) {
        throw new ConflictException('This event has been cancelled');
      }
      // Past the host's RSVP cutoff, accepting is the first half of an RSVP
      // the second half would refuse. Refused here with the same message, so
      // the invitee reads the real reason on the invite itself. Declining
      // stays allowed for the reason above.
      assertRsvpsOpen(event);
      // Accepting always asks who may see the invitee on the attendee list.
      if (!details) {
        throw new BadRequestException('Choose who can see you are going');
      }
      // The real RSVP path: the seat (or waitlist place), the details and the
      // invite flip commit together. A full event, a closed cutoff or an
      // invite that stopped being open refuses the whole thing, so the invite
      // stays as it was and no RSVP is written.
      // It also tells the member who sent the invite, after commit and only
      // as far as the chosen visibility allows (spec decision 7): one rule
      // for this accept and for a direct RSVP that answers the same invite.
      const rsvp = await this.rsvpService.acceptInviteRsvp(
        event.slug,
        userId,
        invite.id,
        details,
      );
      return { id: invite.id, status: EventInviteStatus.Accepted, rsvp };
    }
    invite.status = EventInviteStatus.Declined;
    // Return only what the client needs (the new status), which keeps the
    // `inviterId`/`inviteeId`/`eventId` internal columns out of the response.
    const saved = await this.invites.save(invite);
    return { id: saved.id, status: saved.status, rsvp: null };
  }
}
