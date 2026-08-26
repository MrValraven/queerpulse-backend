import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { EventBanView, toEventBanView } from './event-response';
import { EventBan } from './entities/event-ban.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

/**
 * LOC-08 — a host's control of their own door.
 *
 * Before this, a host afraid of one person had exactly two tools: remove them
 * (and watch them RSVP again a second later, because a cancelled row read as
 * a first RSVP), or cancel the whole gathering. A ban is checked inside
 * `RsvpService.assertMayRsvp`, the same guard the audience tiers already go
 * through, so it holds on every write path onto the roster.
 *
 * Banning also REMOVES any RSVP the member is holding, in the same call: a
 * host who bars somebody means "you are not coming", and leaving them on the
 * going list while the door is shut would be a lie in the host's own
 * dashboard.
 *
 * The barred member is NOT notified. This is deliberate and is the difference
 * between this and a community ban (`CommunityBanned`, which does notify): a
 * community ban ends an ongoing membership somebody would otherwise keep
 * returning to and needs explaining, while an event ban is one host declining
 * one invitation to one evening. A notification here would hand the person a
 * push telling them exactly which gathering to think about, which is the
 * opposite of what a host reaching for this is trying to achieve.
 */
@Injectable()
export class EventBansService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventBan) private readonly bans: Repository<EventBan>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // Removal reuses the existing host-removal path, so a freed seat still
    // pulls the waitlist up exactly as it does when a host removes somebody
    // without banning them.
    private readonly rsvpService: RsvpService,
  ) {}

  /** `POST /events/:slug/bans` — host and co-host only. Idempotent: banning
   *  somebody already banned refreshes nothing and raises nothing. */
  async ban(
    slug: string,
    actorId: string,
    memberSlug: string,
    reason?: string,
  ): Promise<EventBanView> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event, actorId);
    const target = await this.resolveMember(memberSlug);

    if (target.userId === event.hostId) {
      throw new BadRequestException(
        'The host cannot be barred from their own gathering',
      );
    }
    if (target.userId === actorId) {
      throw new BadRequestException('You cannot bar yourself');
    }
    const isCohost = await this.cohosts.exists({
      where: { eventId: event.id, userId: target.userId },
    });
    if (isCohost) {
      throw new BadRequestException(
        'Remove them as a co-host first, then bar them',
      );
    }

    const existing = await this.bans.findOne({
      where: { eventId: event.id, userId: target.userId },
    });
    const ban =
      existing ??
      (await this.bans.save(
        this.bans.create({
          eventId: event.id,
          userId: target.userId,
          bannedByUserId: actorId,
          reason: reason?.trim() || null,
        }),
      ));

    // Bar and remove are one act. `removeAttendee` is idempotent for somebody
    // with no live RSVP, so this is safe whether or not they had one.
    await this.rsvpService.removeAttendee(slug, actorId, memberSlug);

    return toEventBanView(ban, target);
  }

  /** `DELETE /events/:slug/bans/:memberSlug` — host and co-host only.
   *  Idempotent. Lifting the bar does NOT re-add them: they choose whether to
   *  come back. */
  async lift(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event, actorId);
    const target = await this.resolveMember(memberSlug);
    await this.bans.delete({ eventId: event.id, userId: target.userId });
    // The host-removal stamp (`event_rsvps.removed_by_host_at`) is cleared
    // too, or the member would still be barred by the second half of
    // `assertMayRsvp` and the lift would appear to do nothing.
    await this.rsvps.update(
      {
        eventId: event.id,
        userId: target.userId,
        status: RsvpStatus.Cancelled,
      },
      { removedByHostAt: null },
    );
    return { ok: true };
  }

  /** `GET /events/:slug/bans` — host and co-host only. Never reachable by
   *  anyone else: the list, and every `reason` on it, is the organisers'
   *  private note to themselves. */
  async list(slug: string, viewerId: string): Promise<EventBanView[]> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event, viewerId);
    const rows = await this.bans.find({
      where: { eventId: event.id },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];
    const profiles = await this.profiles.find({
      where: { userId: In(rows.map((row) => row.userId)) },
    });
    const byUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    return rows.map((row) => toEventBanView(row, byUserId.get(row.userId)));
  }

  // --- internals ---

  private async resolveMember(memberSlug: string): Promise<Profile> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    return profile;
  }

  private async assertOrganizer(event: Event, userId: string): Promise<void> {
    const isOrganizer =
      event.hostId === userId ||
      (await this.cohosts.exists({
        where: { eventId: event.id, userId },
      }));
    if (!isOrganizer) {
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
}
