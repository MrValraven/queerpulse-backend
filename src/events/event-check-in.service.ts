import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { effectiveCardStatus } from '../membership-cards/card-status';
import { CardTokenService } from '../membership-cards/card-token.service';
import { CommunityCard } from '../membership-cards/entities/community-card.entity';
import { MembershipCard } from '../membership-cards/entities/membership-card.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  EVENT_ATTENDANCE_WINDOW_CLOSED_CODE,
  isAttendanceCleared,
} from './event-attendance-window';
import { AttendeeView, toAttendeeView } from './event-response';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventsService } from './events.service';

/** What a check-in (or an undo) reports back: the attendee's own row as the
 *  organiser now sees it, plus the four numbers the door desk is watching. */
export interface CheckInResultDTO {
  attendee: AttendeeView;
  goingCount: number;
  seatsTaken: number;
  waitlistCount: number;
  /** `null` once the gathering is past the attendance retention window and its
   *  per-person check-in records have been cleared. A door desk is always
   *  inside the window, so in practice this is a number there; the null exists
   *  because the same block is returned from surfaces a host opens later. */
  checkedInCount: number | null;
}

/**
 * LOC-03 — the door.
 *
 * The manage page's primary button was "Day-of dashboard", and the page it
 * opened never read `:slug`: a real host standing at their own door saw a
 * hardcoded title, nine invented guests, "14 expected", and a QR modal that
 * scanned nothing. Tapping a name flipped local state and toasted success.
 * There was no check-in column and no check-in endpoint anywhere.
 *
 * TWO WAYS IN, ONE RECORD. A host taps a name on their attendee list
 * (`memberSlug`), or scans the QR on the member's membership card
 * (`cardToken`). The scan reuses the credential the platform already issues:
 * the string is the card's own permanent Ed25519 code, verified by the same
 * `CardTokenService` that backs `GET /cards/verify/:token`, so a member holds
 * one card and it opens both.
 *
 * WHY THE CARD LOOKUP IS DONE HERE rather than by calling into
 * `MembershipCardsModule`. That module imports `CommunitiesModule`, which
 * imports `EventsModule`, so importing it back would close a dependency
 * cycle. Instead this service takes the card repositories through
 * `TypeOrmModule.forFeature` (the same precedent `AdminCommunitiesModule`
 * uses to read `Community` without importing `CommunitiesModule`) and calls
 * the SHARED pure function `effectiveCardStatus`, so the status precedence a
 * verifier sees is defined in exactly one place and this does not fork it.
 *
 * A REVOKED CARD DOES NOT OPEN A DOOR. The token carries no clock by design;
 * whether the card behind it is still good is a live lookup, here as at
 * `/cards/verify`.
 */
@Injectable()
export class EventCheckInService {
  constructor(
    // Reads `retention.eventAttendanceDays` so the door stops accepting
    // arrivals at exactly the instant the retention sweep stops keeping them.
    private readonly config: ConfigService,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(MembershipCard)
    private readonly cards: Repository<MembershipCard>,
    @InjectRepository(CommunityCard)
    private readonly cardPrograms: Repository<CommunityCard>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly cardTokens: CardTokenService,
    private readonly eventsService: EventsService,
  ) {}

  /**
   * `POST /events/:slug/check-ins` — host and co-host only.
   *
   * Exactly one of `memberSlug` / `cardToken`. Idempotent: checking somebody
   * in twice keeps the FIRST arrival time, because that is the answer to
   * "when did they get here" and a double tap at a busy door must not rewrite
   * it.
   */
  async checkIn(
    slug: string,
    actorId: string,
    input: { memberSlug?: string; cardToken?: string },
  ): Promise<CheckInResultDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event, actorId);
    this.assertAttendanceStillRecorded(event);

    const hasSlug = Boolean(input.memberSlug);
    const hasToken = Boolean(input.cardToken);
    if (hasSlug === hasToken) {
      throw new BadRequestException(
        'Check somebody in by their member slug or by a scanned card, not both',
      );
    }

    const targetUserId = input.memberSlug
      ? await this.resolveByMemberSlug(input.memberSlug)
      : await this.resolveByCardToken(input.cardToken as string);

    const rsvp = await this.rsvps.findOne({
      where: { eventId: event.id, userId: targetUserId },
    });
    if (!rsvp || rsvp.status === RsvpStatus.Cancelled) {
      throw new NotFoundException('That member is not on the guest list');
    }
    if (rsvp.status !== RsvpStatus.Going) {
      // Waitlisted or 'maybe'. Named plainly rather than checked in silently,
      // because the host has a real decision to make at that point (promote
      // them, or turn them away) and the desk should not make it for them.
      throw new BadRequestException(
        rsvp.status === RsvpStatus.Waitlisted
          ? 'That member is on the waitlist. Promote them first, then check them in.'
          : 'That member answered maybe and has no seat yet',
      );
    }

    if (rsvp.checkedInAt === null) {
      rsvp.checkedInAt = new Date();
      await this.rsvps.save(rsvp);
    }
    return this.result(event, rsvp, targetUserId);
  }

  /**
   * `DELETE /events/:slug/check-ins/:memberSlug` — host and co-host only.
   * Undo, for the tap that landed on the wrong name. Idempotent.
   */
  async undoCheckIn(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<CheckInResultDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event, actorId);
    const targetUserId = await this.resolveByMemberSlug(memberSlug);

    const rsvp = await this.rsvps.findOne({
      where: { eventId: event.id, userId: targetUserId },
    });
    if (!rsvp) {
      throw new NotFoundException('That member is not on the guest list');
    }
    // DELIBERATELY NOT GUARDED by `assertAttendanceStillRecorded`. Undo clears
    // a `checked_in_at`, so it REMOVES the personal data the retention window
    // exists to remove and can never re-create it. Refusing it past the window
    // would be the one outcome nobody wants: a stray arrival stamp that the
    // sweep has not reached yet and that a host is now forbidden from taking
    // off. Clearing an already-null value is a no-op, so this stays safe and
    // available forever.
    if (rsvp.checkedInAt !== null) {
      rsvp.checkedInAt = null;
      await this.rsvps.save(rsvp);
    }
    return this.result(event, rsvp, targetUserId);
  }

  // --- internals ---

  /**
   * Refuse to record an arrival on a gathering whose attendance window has
   * closed.
   *
   * Writing a fresh `checked_in_at` here would re-create the exact personal
   * data `EventAttendanceRetentionService` has already erased, on a gathering
   * the published privacy policy promises to have cleared, and would leave one
   * arrival recorded against a gathering whose others are gone (flipping
   * `checkedInCount` back from "no longer recorded" to 1).
   *
   * Uses `isAttendanceCleared`, the SAME predicate reading the same
   * `retention.eventAttendanceDays` key that the sweep and `rosterCounts` use,
   * rather than a second clock. That is what makes the boundary agree exactly:
   * at the instant the count starts reporting "no longer recorded", the door
   * stops accepting, and one millisecond earlier both still work.
   *
   * Checked straight after the organiser check and before the member lookup:
   * this is a property of the GATHERING, not of whoever is being checked in, so
   * there is no reason to resolve a member slug or verify a scanned card for a
   * request that cannot be honoured either way.
   */
  private assertAttendanceStillRecorded(event: Event): void {
    const retentionDays = this.config.get<number>(
      'retention.eventAttendanceDays',
      30,
    );
    if (!isAttendanceCleared(event, retentionDays)) {
      return;
    }
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: EVENT_ATTENDANCE_WINDOW_CLOSED_CODE,
      message: `Arrivals are only recorded for ${retentionDays} days after a gathering. This one is past that, so its check-in records have been cleared and no new ones can be added.`,
    });
  }

  // Takes the loaded `event`, not its id: `rosterCounts` needs the gathering's
  // date to decide whether its check-in records still exist (see that method),
  // and both callers above already hold the row, so this costs no extra query
  // on the door's hot path.
  private async result(
    event: Event,
    rsvp: EventRsvp,
    targetUserId: string,
  ): Promise<CheckInResultDTO> {
    const [profile, counts] = await Promise.all([
      this.profiles.findOne({ where: { userId: targetUserId } }),
      this.eventsService.rosterCounts(event),
    ]);
    return {
      // `forOrganizer: true` — this method is only ever reached through the
      // organiser-guarded routes above.
      attendee: toAttendeeView(rsvp, profile ?? undefined, true),
      ...counts,
    };
  }

  private async resolveByMemberSlug(memberSlug: string): Promise<string> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    return profile.userId;
  }

  /**
   * A scanned card code to the member holding it.
   *
   * Every failure — malformed, tampered, wrong signing key, superseded code
   * version, missing card, missing programme, missing community, or a card
   * that is revoked, suspended or expired — is ONE message. A door scanner
   * that distinguishes them tells whoever is holding the phone which part of
   * the platform's card population they just probed.
   */
  private async resolveByCardToken(cardToken: string): Promise<string> {
    const unreadable = new BadRequestException(
      'That card could not be read. Check them in by name instead.',
    );
    const payload = this.cardTokens.verify(cardToken);
    if (!payload) throw unreadable;

    const card = await this.cards.findOne({ where: { id: payload.cardId } });
    if (!card) throw unreadable;
    // The generation check: a card whose issuer replaced it keeps its row and
    // its serial, and every printed copy of the previous code stops working.
    if (card.codeVersion !== payload.codeVersion) throw unreadable;

    const program = await this.cardPrograms.findOne({
      where: { id: card.programId },
    });
    if (!program) throw unreadable;
    const community = await this.communities.findOne({
      where: { id: program.issuerId },
    });
    if (!community) throw unreadable;

    const status = effectiveCardStatus({
      status: card.status,
      expiresAt: card.expiresAt,
      programEnabled: program.isEnabled,
      communityFrozenAt: community.frozenAt,
      communityArchivedAt: community.archivedAt,
    });
    if (status !== 'active') throw unreadable;

    return card.userId;
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
