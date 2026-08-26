import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { normalizePage, paginate } from '../common/pagination';
import { randomBytes } from 'node:crypto';
import {
  EntityManager,
  In,
  MoreThan,
  MoreThanOrEqual,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  AttachableListingRef,
  ListingLookupService,
} from '../listings/listing-lookup.service';
import {
  ListingAccessibilityAnswer,
  normalizeAccessibilityAnswers,
} from '../listings/listing-accessibility';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AttendeeStatusFilter } from './dto/list-attendees.query';
import type { EventCostFilter } from './dto/list-events.query';
import type {
  RecurrenceCadence,
  RecurrenceEndType,
} from './dto/recurrence.dto';
import {
  AttendeesPageDTO,
  EventDetail,
  EventLineupDTO,
  EventOrganizerView,
  EventSummary,
  toAttendeeView,
  toEventAnnouncementView,
  toEventSummary,
  toEventVenueAttachmentView,
  toLineupEntryView,
  toOrganizerView,
  toRsvpDetailsView,
} from './event-response';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import {
  EventSeries,
  EventSeriesCadence,
  EventSeriesEndType,
} from './entities/event-series.entity';
import {
  Event,
  EventStatus,
  EventVenueConfirmation,
  EventVisibility,
} from './entities/event.entity';
import { RsvpService } from './rsvp.service';

/** Edit/cancel scope for a recurring occurrence — see `SeriesScopeQuery`'s doc. */
export type SeriesScope = 'this' | 'future';

/**
 * What one occurrence's patch changed, handed back by `applyUpdate` so its
 * caller can run the side effects AFTER the transaction commits.
 *
 * `applyUpdate` used to reconcile the waitlist and notify attendees inline. In
 * a `scope: 'future'` series edit that meant both fired per occurrence, mid
 * loop, before the rest of the series was written — and waitlist reconciliation
 * opens its own transaction with a `pessimistic_write` lock, which must never
 * nest inside the one doing the writes.
 */
interface AppliedEventUpdate {
  event: Event;
  /** Capacity grew on a published event, so seats may have opened up. */
  shouldReconcileWaitlist: boolean;
  /** `startAt` / location fields that moved, empty when nothing notifiable did. */
  materialChanges: string[];
  /** LOC-16: this patch left the gathering attached to a directory listing
   *  that has never been asked about it, and the gathering can now reach that
   *  venue's public page. Raised AFTER the transaction commits, like every
   *  other notification here: an ask that cannot be un-sent must not describe
   *  a write that rolled back. `null` when there is nothing to ask. */
  venueOwnerToNotify: AttachableListingRef | null;
}

export interface LineupEntryInput {
  memberSlug: string;
  role: string;
}

export interface CreateEventInput {
  title: string;
  description: string;
  startAt: string;
  endAt?: string;
  timezone: string;
  venue?: string;
  // `null` (update only — `create()` treats it the same as absent, since
  // there's no existing link to detach) explicitly detaches the venue from a
  // directory listing; a uuid resolves+validates it (400 if not a live
  // listing); absent (the `Partial` in `UpdateEventInput` below) leaves it
  // unchanged on update. Mirrors `communitySlug` below in shape.
  listingId?: string | null;
  isOnline?: boolean;
  onlineUrl?: string;
  capacity?: number;
  visibility?: EventVisibility;
  status?: EventStatus.Draft | EventStatus.Published;
  coverImageUrl?: string;
  // ── Where it actually is (LOC-04) — see `Event.address`'s doc. Same
  // absent/null/value three-way as `communitySlug` below on update; `create()`
  // treats null/''/absent alike.
  address?: string | null;
  arrivalNotes?: string | null;
  neighbourhood?: string | null;
  language?: string | null;
  eventType?: string | null;
  accessibility?: {
    answers?: Partial<Record<string, ListingAccessibilityAnswer>>;
    note?: string;
  };
  // Free-text door price (LOC-18). Display only; no payment code anywhere.
  cost?: string | null;
  // `null`/`''` (update only — `create()` treats them the same as absent,
  // since there's no existing community to detach from) explicitly clears
  // `communityId`; a non-empty slug resolves/authorizes it; absent (the
  // `Partial` in `UpdateEventInput` below) leaves it unchanged on update.
  communitySlug?: string | null;
  // Manage-dashboard "Options" toggles — see `Event.allowWaitlist`'s doc.
  allowWaitlist?: boolean;
  showAttendeeCount?: boolean;
  // Optional repeat rule (MSG-10) — see `RecurrenceDto`'s doc. CREATE-only;
  // `UpdateEventInput` (below) never carries this.
  recurrence?: {
    cadence: RecurrenceCadence;
    endType: RecurrenceEndType;
    endCount?: number;
    endUntil?: string;
  };
}

export type UpdateEventInput = Partial<Omit<CreateEventInput, 'recurrence'>>;
export type EventListFilter =
  'upcoming' | 'going' | 'hosting' | 'waitlisted' | 'past' | 'saved';

const PAGE_SIZE = 20;

// Generous cap on a single "who performed" lineup — mirrors
// `ReplaceAffiliationsDTO`'s `ArrayMaxSize` shape (validated again here so a
// caller can't route around the DTO cap by calling the service directly).
const MAX_LINEUP_ENTRIES = 50;

// Hard cap on how many `Event` rows one series creates up front (a year of
// weekly occurrences). Keeps the "generate everything now, no cron job"
// design (see `EventSeries`'s class doc) bounded regardless of how far out
// an `endUntil` date is, or how large an `endCount` is requested.
const MAX_OCCURRENCES = 52;

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on the
// QueryFailedError or on the wrapped driverError depending on the path.
// null capacity means unlimited. "Increased" = strictly more seats than before:
// a bigger number, or a number lifted to unlimited. Shrinking never promotes.
function capacityIncreased(
  oldCapacity: number | null,
  newCapacity: number | null,
): boolean {
  if (oldCapacity === null) return false; // already unlimited — nothing to free
  if (newCapacity === null) return true; // finite → unlimited
  return newCapacity > oldCapacity;
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(EventLineupEntry)
    private readonly lineupEntries: Repository<EventLineupEntry>,
    @InjectRepository(EventSeries)
    private readonly eventSeries: Repository<EventSeries>,
    // Host announcements (LOC-06) — read here so an event's detail can carry
    // "we moved to the back room" on the page itself, not only in a
    // notification that has since scrolled away. Writing them belongs to
    // `EventAnnouncementsService`.
    @InjectRepository(EventAnnouncement)
    private readonly announcements: Repository<EventAnnouncement>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
    private readonly rsvpService: RsvpService,
    private readonly notifications: NotificationsService,
    private readonly blockFilter: BlockFilterService,
    private readonly contentModeration: ContentModerationService,
    private readonly membership: CommunityMembershipService,
    private readonly bookmarks: EventBookmarksService,
    // Note: `ConnectionsService` itself is NOT injected here — every call
    // this service used to make into it (`allAcceptedConnectionUserIds` for
    // the browse/search predicate, `areConnected`/`mutualCountsByUserIds` for
    // the per-event gate) now goes through `audienceGate` below, which owns
    // both (fix round 2 moved `scopedVisibilityWhere` there so
    // `EventBookmarksService` could reuse it too — see its class doc).
    private readonly audienceGate: EventAudienceGateService,
    // Batched crop lookup (`MediaCropService.getMany`) for `coverImageUrl`'s
    // sibling `coverCrop`.
    private readonly mediaCropService: MediaCropService,
    // Resolves+validates an optional `listingId` against a real, live
    // directory listing — see `CreateEventInput.listingId`.
    private readonly listingLookup: ListingLookupService,
  ) {}

  // Events are reported (and taken down) under the `event` taxonomy code, keyed
  // by the event's uuid.
  private static readonly SUBJECT_TYPE = 'event';

  // Excludes moderator-taken-down events from a browse/search query, in-query so
  // pagination and any `take` limit stay consistent. Applied to the PUBLIC
  // discovery surfaces only (`upcoming` browse + global search); an organizer
  // still reaches a taken-down event through their hosting context and the
  // detail gate (`assertCanView`) admits them.
  private excludeModeratedEvents(qb: SelectQueryBuilder<Event>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :eventSubjectType
          AND "cm"."subject_id" = e.id::text
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { eventSubjectType: EventsService.SUBJECT_TYPE },
    );
  }

  async create(hostId: string, dto: CreateEventInput): Promise<EventDetail> {
    const startAt = new Date(dto.startAt);
    const endAt = dto.endAt ? new Date(dto.endAt) : null;
    this.assertScheduleValid(startAt, endAt, { rejectPast: true });

    let communityId: string | null = null;
    if (dto.communitySlug) {
      communityId = await this.membership.assertMemberBySlug(
        dto.communitySlug,
        hostId,
      );
    }
    const visibility = dto.visibility ?? EventVisibility.Public;
    if (visibility === EventVisibility.Community && !communityId) {
      throw new BadRequestException(
        'Community-only gatherings require a community',
      );
    }

    // LOC-16. The venue is resolved to a full ref (id, slug, name, owner) so
    // the attachment can ask its owner for consent below. The attachment
    // itself starts PENDING: until the owner confirms, the gathering is
    // withheld from the anonymous, CDN-cached version of that venue's page.
    const venueListing = dto.listingId
      ? await this.assertAttachableListing(dto.listingId)
      : null;
    const listingId = venueListing?.id ?? null;
    const visibilityReachesVenuePage =
      visibility === EventVisibility.Public ||
      visibility === EventVisibility.Members;
    const status = dto.status ?? EventStatus.Published;
    // The ask is raised once, for the whole create call. A weekly series
    // creates twelve rows, and twelve bells for one decision is not an ask,
    // it is a flood, so every occurrence is stamped as already-asked and one
    // notification names the first of them.
    const shouldAskVenueOwner =
      venueListing !== null &&
      venueListing.ownerId !== null &&
      status === EventStatus.Published &&
      visibilityReachesVenuePage;

    // MSG-10 — a `recurrence` rule expands this one create() call into a
    // whole series: `resolveOccurrences` computes every occurrence's own
    // start/end up front (capped at `MAX_OCCURRENCES`), an `EventSeries` row
    // is created to hold the repeat rule, and one independent `Event` row is
    // written per occurrence below — each fully RSVPable/editable/cancelable
    // on its own via the normal slug-keyed endpoints. No `recurrence` (the
    // common case) is exactly the prior single-event behavior: one
    // occurrence, no series.
    const occurrences = this.resolveOccurrences(startAt, endAt, dto.recurrence);
    let seriesId: string | null = null;
    if (occurrences.length > 1 && dto.recurrence) {
      const series = await this.eventSeries.save(
        this.eventSeries.create({
          hostId,
          cadence: dto.recurrence.cadence as EventSeriesCadence,
          endType: dto.recurrence.endType as EventSeriesEndType,
          endCount:
            dto.recurrence.endType === 'count'
              ? (dto.recurrence.endCount ?? null)
              : null,
          endUntil:
            dto.recurrence.endType === 'date' && dto.recurrence.endUntil
              ? new Date(dto.recurrence.endUntil)
              : null,
          occurrenceCount: occurrences.length,
        }),
      );
      seriesId = series.id;
    }

    // Every occurrence shares the same content (title, description, venue,
    // audience scope, …) — only `startAt`/`endAt` and `seriesIndex` differ
    // per row. `saveWithUniqueSlug` already de-dupes identical titles (the
    // 2nd..Nth occurrence of "Weekly Support Group" gets a random-suffixed
    // slug), so no extra handling is needed here.
    let firstSaved: Event | null = null;
    for (const [index, occurrence] of occurrences.entries()) {
      const event = this.events.create({
        hostId,
        slug: '', // assigned (race-safely) by saveWithUniqueSlug
        title: dto.title,
        description: dto.description,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
        timezone: dto.timezone,
        venue: dto.venue ?? null,
        listingId,
        // LOC-16, see `EventVenueConfirmation`. Set explicitly rather than
        // left to the column default so the in-memory row and the stored row
        // agree from the first line of code that reads either.
        venueConfirmation: EventVenueConfirmation.Pending,
        venueOwnerNotifiedAt: shouldAskVenueOwner ? new Date() : null,
        isOnline: dto.isOnline ?? false,
        onlineUrl: dto.onlineUrl ?? null,
        capacity: dto.capacity ?? null,
        visibility,
        status,
        coverImageUrl: dto.coverImageUrl ?? null,
        // LOC-04/LOC-18. `?? null` for every one of them, including the empty
        // string a wizard sends for a field the host skipped: an empty
        // address is "no address given", never a zero-length street.
        address: EventsService.blankToNull(dto.address),
        arrivalNotes: EventsService.blankToNull(dto.arrivalNotes),
        neighbourhood: EventsService.blankToNull(dto.neighbourhood),
        language: EventsService.blankToNull(dto.language),
        eventType: EventsService.blankToNull(dto.eventType),
        // Always a COMPLETE six-question map on write, so a reader never has
        // to tell an absent key from an unanswered question — the whole point
        // of the three-valued model this borrows from `listings`.
        accessibilityAnswers: normalizeAccessibilityAnswers(
          dto.accessibility?.answers,
        ),
        accessibilityNote: dto.accessibility?.note?.trim() ?? '',
        cost: EventsService.blankToNull(dto.cost),
        communityId,
        allowWaitlist: dto.allowWaitlist ?? true,
        showAttendeeCount: dto.showAttendeeCount ?? true,
        seriesId,
        seriesIndex: seriesId ? index : null,
      });
      const saved = await this.saveWithUniqueSlug(event, dto.title);
      if (index === 0) firstSaved = saved;
    }
    // `firstSaved` is always set: `occurrences` always has at least one entry
    // (the gathering's own start), so the loop runs at least once with
    // `index === 0`.
    if (shouldAskVenueOwner && venueListing) {
      await this.notifyVenueOwnerBestEffort(firstSaved!, venueListing);
    }
    return this.buildDetail(firstSaved!, hostId);
  }

  // Computes every occurrence's own `{ startAt, endAt }` for a create() call,
  // capped at `MAX_OCCURRENCES`. No `recurrence` → a single-element array (the
  // gathering's own schedule, unchanged) — the non-recurring path. `endAt`'s
  // duration (when set) is preserved across every occurrence.
  private resolveOccurrences(
    startAt: Date,
    endAt: Date | null,
    recurrence?: CreateEventInput['recurrence'],
  ): { startAt: Date; endAt: Date | null }[] {
    if (!recurrence) return [{ startAt, endAt }];

    const durationMs = endAt ? endAt.getTime() - startAt.getTime() : null;
    let maxCount = MAX_OCCURRENCES;
    let untilMs: number | null = null;

    if (recurrence.endType === 'count') {
      if (!recurrence.endCount) {
        throw new BadRequestException(
          'endCount is required when endType is "count"',
        );
      }
      maxCount = Math.min(recurrence.endCount, MAX_OCCURRENCES);
    } else {
      if (!recurrence.endUntil) {
        throw new BadRequestException(
          'endUntil is required when endType is "date"',
        );
      }
      const until = new Date(recurrence.endUntil);
      if (
        Number.isNaN(until.getTime()) ||
        until.getTime() <= startAt.getTime()
      ) {
        throw new BadRequestException(
          "endUntil must be after the gathering's start",
        );
      }
      untilMs = until.getTime();
    }

    const occurrences: { startAt: Date; endAt: Date | null }[] = [];
    for (let index = 0; index < maxCount; index++) {
      const occurrenceStart = EventsService.addCadence(
        startAt,
        recurrence.cadence,
        index,
      );
      if (untilMs !== null && occurrenceStart.getTime() > untilMs) break;
      const occurrenceEnd =
        durationMs !== null
          ? new Date(occurrenceStart.getTime() + durationMs)
          : null;
      occurrences.push({ startAt: occurrenceStart, endAt: occurrenceEnd });
    }
    return occurrences;
  }

  // The Nth occurrence's start, `index` cadence-steps after `base` (index 0
  // === `base` itself). Monthly uses `setMonth`, so a 31st-of-the-month start
  // rolls into the next month on a shorter one (JS `Date` overflow) — an
  // accepted, documented edge case for this deliberately minimal recurrence
  // model (no RFC5545 "same weekday" or "last day of month" semantics).
  private static addCadence(
    base: Date,
    cadence: RecurrenceCadence,
    index: number,
  ): Date {
    const next = new Date(base);
    if (cadence === 'weekly') next.setDate(next.getDate() + 7 * index);
    else if (cadence === 'biweekly') next.setDate(next.getDate() + 14 * index);
    else next.setMonth(next.getMonth() + index); // 'monthly'
    return next;
  }

  async getBySlug(slug: string, viewerId: string): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertCanView(event, viewerId);
    return this.buildDetail(event, viewerId);
  }

  /**
   * `scope` (MSG-10) — for an occurrence that belongs to a series,
   * `'future'` also applies the same patch to every LATER occurrence in the
   * series (`seriesIndex` strictly after this one), skipping any that are
   * already cancelled. `startAt`/`endAt` are deliberately never propagated —
   * each occurrence keeps its own date; only structural fields (title,
   * description, venue, audience, options, …) carry across. Per-occurrence
   * authorization isn't re-checked for the propagated siblings: the caller
   * already proved they organize THIS occurrence, every occurrence in a
   * series shares the same `hostId` (set once at series-create time), and
   * bulk-applying a structural edit across a series is exactly what
   * `'future'` scope is for. `'this'` (the default) is unchanged prior
   * behavior — a single event's own update.
   */
  async update(
    slug: string,
    userId: string,
    dto: UpdateEventInput,
    scope: SeriesScope = 'this',
  ): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, userId);

    // `seriesId`/`seriesIndex` are never patchable, so the sibling set can be
    // resolved from the unpatched row and the whole series written in ONE
    // transaction. The loop this replaced saved each occurrence on its own and
    // fanned notifications out as it went, so a throw part-way through left the
    // series half edited with no rollback, and attendees had already been told
    // about occurrences that no longer matched the ones behind them.
    const { startAt: _startAt, endAt: _endAt, ...seriesPatch } = dto;
    const futureSiblings =
      scope === 'future' && event.seriesId && event.seriesIndex !== null
        ? await this.events.find({
            where: {
              seriesId: event.seriesId,
              seriesIndex: MoreThan(event.seriesIndex),
              status: Not(EventStatus.Cancelled),
            },
          })
        : [];

    const applied: AppliedEventUpdate[] = [];
    await this.events.manager.transaction(async (manager) => {
      applied.push(await this.applyUpdate(event, userId, dto, manager));
      for (const sibling of futureSiblings) {
        applied.push(
          await this.applyUpdate(sibling, userId, seriesPatch, manager),
        );
      }
    });

    // Everything with an effect OUTSIDE this transaction runs after it commits:
    // waitlist promotion takes its own transaction with a `pessimistic_write`
    // lock (nesting that inside ours would be a deadlock waiting to happen),
    // and a notification cannot be un-sent if the write it describes rolls back.
    for (const outcome of applied) {
      if (outcome.shouldReconcileWaitlist) {
        await this.rsvpService.reconcileWaitlist(outcome.event.slug);
      }
    }
    for (const outcome of applied) {
      if (outcome.materialChanges.length > 0) {
        await this.notifyEventUpdated(
          outcome.event,
          userId,
          outcome.materialChanges,
        );
      }
    }
    // LOC-16: ask the venue's owner, after the write is durable. A series
    // edit under `scope: 'future'` can leave several occurrences newly
    // attached, so the owner is asked about the FIRST of them and the rest are
    // stamped as asked, matching `create()`'s one-ask-per-series rule.
    const venueAsks = applied.filter(
      (outcome) => outcome.venueOwnerToNotify !== null,
    );
    const [firstAsk] = venueAsks;
    if (firstAsk?.venueOwnerToNotify) {
      await this.notifyVenueOwnerBestEffort(
        firstAsk.event,
        firstAsk.venueOwnerToNotify,
      );
      for (const outcome of venueAsks.slice(1)) {
        await this.events.update(
          { id: outcome.event.id },
          { venueOwnerNotifiedAt: new Date() },
        );
      }
    }

    const saved = applied[0]?.event ?? event;
    return this.buildDetail(saved, userId);
  }

  // The actual single-event patch — everything `update()` did before MSG-10
  // added series scope. Called once for the primary occurrence and, under
  // `scope: 'future'`, once more per later sibling (see `update()`'s doc).
  private async applyUpdate(
    event: Event,
    userId: string,
    dto: UpdateEventInput,
    // Present when this patch is part of a series edit: the save has to join
    // the caller's transaction so every occurrence lands together. The
    // side effects this method used to perform inline (waitlist reconciliation,
    // the attendee notification) are REPORTED back instead of run here, so the
    // caller can run them once the transaction has actually committed.
    manager?: EntityManager,
  ): Promise<AppliedEventUpdate> {
    // A cancelled event is terminal: cancel() is the only way in and there is no
    // way back out. The update DTO only allows Draft | Published for status, so
    // any provided status is a reopen attempt and must be rejected.
    if (event.status === EventStatus.Cancelled && dto.status !== undefined) {
      throw new ConflictException('A cancelled event cannot be reopened');
    }

    // Shared-upload backstop (see `assertNoForeignUploadIntroduced`): an event
    // is edited by its cohosts, so the interceptor exempts it and lets a cohost
    // re-save the currently stored cover whoever uploaded it. Runs BEFORE any
    // mutation, once per occurrence (a `scope: 'future'` series edit calls this
    // for each sibling against ITS own stored cover): a foreign cover is allowed
    // only when it is already this occurrence's stored value, so a cohost cannot
    // point the field at a new foreign upload.
    assertNoForeignUploadIntroduced(userId, dto.coverImageUrl, [
      event.coverImageUrl,
    ]);

    // Resolve the EFFECTIVE community for this patch. `communitySlug`
    // (fix round 2 — was create()-only before) mirrors `create()`'s handling
    // exactly:
    //   - absent from the DTO -> leave `event.communityId` unchanged.
    //   - `null` or `''` -> explicit detach (`communityId = null`).
    //   - a non-empty slug -> resolve via `assertMemberBySlug`, THE SAME
    //     authorization `create()` uses (resolve slug -> community, 404 if
    //     missing/archived, 403 if the caller isn't on its roster) — not a
    //     weaker re-check. Authorized against `userId`, the acting
    //     organizer already asserted above (host or co-host), mirroring
    //     `create()`'s "the actor must themselves be on the target
    //     community's roster" rule.
    let communityId = event.communityId;
    if (dto.communitySlug !== undefined) {
      communityId =
        dto.communitySlug === null || dto.communitySlug === ''
          ? null
          : await this.membership.assertMemberBySlug(dto.communitySlug, userId);
    }

    // Community-only gatherings require a community — checked against the
    // EFFECTIVE post-patch community (just resolved above) and the EFFECTIVE
    // post-patch visibility, not just what's in this DTO. Covers both
    // directions: switching visibility to `community` with no community
    // resolved, AND detaching the community while visibility is still
    // `community` (frontend is expected to reset scope when detaching, but
    // the backend stays authoritative either way).
    const nextVisibility = dto.visibility ?? event.visibility;
    if (nextVisibility === EventVisibility.Community && !communityId) {
      throw new BadRequestException(
        'Community-only gatherings require a community',
      );
    }

    // Same absent/null/uuid three-way as `communitySlug` above: absent
    // leaves the existing link (if any) unchanged, `null` explicitly
    // detaches it (falling back to plain-text `venue`), a uuid
    // resolves+validates the new link.
    let listingId = event.listingId;
    let venueListing: AttachableListingRef | null = null;
    if (dto.listingId !== undefined) {
      venueListing = dto.listingId
        ? await this.assertAttachableListing(dto.listingId, event)
        : null;
      listingId = venueListing?.id ?? null;
    }
    // LOC-16. A NEW venue is a new ask: the consent state, its stamp and the
    // "already asked" marker all reset together, so an owner never inherits
    // another venue's confirmation and the next ask is never suppressed by a
    // marker left over from a venue this gathering has since left.
    const isNewVenue = listingId !== event.listingId;

    const oldStartAt = event.startAt;
    const oldCapacity = event.capacity;
    // Snapshot the material fields (when + where) before the patch so we can
    // tell afterwards whether the edit is worth notifying attendees about.
    const oldVenue = event.venue;
    const oldIsOnline = event.isOnline;
    const oldOnlineUrl = event.onlineUrl;
    // The street address and the arrival note are "where", exactly as much as
    // the venue name is — a host who moves the door and tells nobody is the
    // failure this notification exists to prevent (LOC-04).
    const oldAddress = event.address;
    const oldArrivalNotes = event.arrivalNotes;
    const oldNeighbourhood = event.neighbourhood;

    // Validate the resulting schedule (effective start/end after the patch).
    const nextStartAt =
      dto.startAt !== undefined ? new Date(dto.startAt) : event.startAt;
    const nextEndAt =
      dto.endAt !== undefined
        ? dto.endAt
          ? new Date(dto.endAt)
          : null
        : event.endAt;
    this.assertScheduleValid(nextStartAt, nextEndAt, { rejectPast: false });

    Object.assign(event, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.startAt !== undefined ? { startAt: new Date(dto.startAt) } : {}),
      ...(dto.endAt !== undefined
        ? { endAt: dto.endAt ? new Date(dto.endAt) : null }
        : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      ...(dto.venue !== undefined ? { venue: dto.venue ?? null } : {}),
      ...(dto.listingId !== undefined ? { listingId } : {}),
      ...(isNewVenue
        ? {
            venueConfirmation: EventVenueConfirmation.Pending,
            venueConfirmedAt: null,
            venueOwnerNotifiedAt: null,
          }
        : {}),
      ...(dto.isOnline !== undefined ? { isOnline: dto.isOnline } : {}),
      ...(dto.onlineUrl !== undefined
        ? { onlineUrl: dto.onlineUrl ?? null }
        : {}),
      ...(dto.capacity !== undefined ? { capacity: dto.capacity ?? null } : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.coverImageUrl !== undefined
        ? { coverImageUrl: dto.coverImageUrl ?? null }
        : {}),
      ...(dto.communitySlug !== undefined ? { communityId } : {}),
      ...(dto.allowWaitlist !== undefined
        ? { allowWaitlist: dto.allowWaitlist }
        : {}),
      ...(dto.showAttendeeCount !== undefined
        ? { showAttendeeCount: dto.showAttendeeCount }
        : {}),
      // LOC-04/LOC-18. Absent leaves the stored value alone; `null` or `''`
      // clears it; a value replaces it.
      ...(dto.address !== undefined
        ? { address: EventsService.blankToNull(dto.address) }
        : {}),
      ...(dto.arrivalNotes !== undefined
        ? { arrivalNotes: EventsService.blankToNull(dto.arrivalNotes) }
        : {}),
      ...(dto.neighbourhood !== undefined
        ? { neighbourhood: EventsService.blankToNull(dto.neighbourhood) }
        : {}),
      ...(dto.language !== undefined
        ? { language: EventsService.blankToNull(dto.language) }
        : {}),
      ...(dto.eventType !== undefined
        ? { eventType: EventsService.blankToNull(dto.eventType) }
        : {}),
      ...(dto.cost !== undefined
        ? { cost: EventsService.blankToNull(dto.cost) }
        : {}),
      // Accessibility answers MERGE per question rather than replacing the
      // map: a host correcting "accessible toilet" must not silently blank
      // the other five answers back to unknown. The note replaces wholesale,
      // being one value.
      ...(dto.accessibility?.answers !== undefined
        ? {
            accessibilityAnswers: normalizeAccessibilityAnswers({
              ...normalizeAccessibilityAnswers(event.accessibilityAnswers),
              ...dto.accessibility.answers,
            }),
          }
        : {}),
      ...(dto.accessibility?.note !== undefined
        ? { accessibilityNote: dto.accessibility.note.trim() }
        : {}),
    });

    // Pushing the start later makes an already-sent reminder premature — re-arm
    // it so the cron fires again against the new time.
    if (
      dto.startAt !== undefined &&
      event.startAt.getTime() > oldStartAt.getTime()
    ) {
      event.reminderSentAt = null;
    }

    const saved = manager
      ? await manager.save(Event, event)
      : await this.events.save(event);

    // Growing capacity (or lifting it entirely) can free seats — pull the
    // waitlist head(s) up. Skip on non-published events (nothing to admit into).
    const shouldReconcileWaitlist =
      saved.status === EventStatus.Published &&
      capacityIncreased(oldCapacity, saved.capacity);

    // Material change → tell the people counting on this event. "Material" is
    // when (start time) or where (venue / online flag / online URL) — the two
    // things a member plans around. Trivial edits (title, description, cover,
    // capacity, visibility) deliberately do NOT notify: this is a "you need to
    // re-plan" signal, not a changelog, so it stays low-noise. Only published
    // events fan out — a draft is the organizers' private workspace, and a
    // cancelled event already got its own EventCancelled notice.
    const materialChanges: string[] = [];
    if (saved.startAt.getTime() !== oldStartAt.getTime()) {
      materialChanges.push('startAt');
    }
    if (
      saved.venue !== oldVenue ||
      saved.isOnline !== oldIsOnline ||
      saved.onlineUrl !== oldOnlineUrl ||
      saved.address !== oldAddress ||
      saved.arrivalNotes !== oldArrivalNotes ||
      saved.neighbourhood !== oldNeighbourhood
    ) {
      materialChanges.push('location');
    }
    // LOC-16: is there a venue owner who still has to be asked?
    //
    // Four separate edits arrive here and all four have to raise the ask
    // exactly once: attaching a venue for the first time, swapping one venue
    // for another, PUBLISHING a draft that already named a venue, and WIDENING
    // a `network`-scoped gathering to `public`/`members`. The last two are why
    // this is computed from the SAVED row rather than from `dto.listingId`:
    // neither of them touches the venue field at all, and both are the moment
    // the gathering first becomes something that can appear on a business's
    // public page.
    //
    // `venueOwnerNotifiedAt` is the idempotency key. It is stamped by
    // `notifyVenueOwnerBestEffort` after the send and cleared only when the
    // venue itself changes, so no sequence of edits can ask the same owner
    // about the same attachment twice.
    const venueOwnerToNotify = await this.resolveVenueOwnerToNotify(
      saved,
      venueListing,
    );
    return {
      event: saved,
      shouldReconcileWaitlist,
      materialChanges:
        saved.status === EventStatus.Published ? materialChanges : [],
      venueOwnerToNotify,
    };
  }

  /**
   * The listing whose owner should be asked about `event`, or null when
   * nobody should be (LOC-16).
   *
   * Null in every one of these cases, each for its own reason:
   *  - no venue attached, or the owner has already been asked;
   *  - the attachment is already `confirmed` (including the grandfathered
   *    pre-LOC-16 ones, which must not generate a retro-active ask for a link
   *    that has been on the page for months);
   *  - the gathering is a DRAFT, or scoped tighter than `members`. Neither can
   *    reach the venue's public page, so there is nothing to consent to, and
   *    naming an `invite_only` or `network` gathering to somebody outside its
   *    audience would be a disclosure this feature has no right to make;
   *  - the listing has nobody to ask (unclaimed, or its owner's account was
   *    erased). The attachment simply stays pending, which is the safe state.
   */
  private async resolveVenueOwnerToNotify(
    event: Event,
    alreadyResolved: AttachableListingRef | null,
  ): Promise<AttachableListingRef | null> {
    if (!event.listingId) return null;
    if (event.venueConfirmation !== EventVenueConfirmation.Pending) return null;
    if (event.venueOwnerNotifiedAt !== null) return null;
    if (event.status !== EventStatus.Published) return null;
    if (
      event.visibility !== EventVisibility.Public &&
      event.visibility !== EventVisibility.Members
    ) {
      return null;
    }
    const listing =
      alreadyResolved && alreadyResolved.id === event.listingId
        ? alreadyResolved
        : await this.listingLookup.findAttachable(event.listingId);
    return listing && listing.ownerId ? listing : null;
  }

  /**
   * Tells a business's owner that a gathering has attached itself to their
   * venue, and stamps the attachment as asked (LOC-16).
   *
   * NO ACTOR ARGUMENT, deliberately. `NotificationsService.create`'s fourth
   * parameter runs the block/mute filter, and passing the host there would
   * mean a host the owner has blocked could attach a gathering to that owner's
   * business page and silently suppress the one warning they would ever get.
   * The bell names the venue and the gathering; who organised it is on the
   * gathering's own page.
   *
   * The stamp is written even if the notification write fails. A missing bell
   * is a missed message; a missing stamp is the same owner asked again on
   * every subsequent edit of the gathering.
   */
  private async notifyVenueOwnerBestEffort(
    event: Event,
    listing: AttachableListingRef,
  ): Promise<void> {
    const notifiedAt = new Date();
    try {
      await this.events.update(
        { id: event.id },
        { venueOwnerNotifiedAt: notifiedAt },
      );
      event.venueOwnerNotifiedAt = notifiedAt;
      if (!listing.ownerId) return;
      await this.notifications.create(
        listing.ownerId,
        NotificationType.VenueEventAttachment,
        {
          source: 'listing',
          listingSlug: listing.slug,
          listingName: listing.name,
          eventSlug: event.slug,
          eventTitle: event.title,
        },
      );
    } catch {
      // Intentionally ignored: the gathering itself is already saved, and a
      // failed bell must not fail the host's create or edit.
    }
  }

  /**
   * Fan an `EventUpdated` notification out to everyone with a stake in the
   * event — a live RSVP (going/maybe/waitlisted) or a standing invite — minus
   * the organizer who made the edit. Recipients are de-duplicated so a member
   * who is both invited and RSVP'd gets exactly one row per update (no spam),
   * mirroring the `EventCancelled` fan-out in `cancel()`.
   */
  private async notifyEventUpdated(
    event: Event,
    editorId: string,
    changes: string[],
  ): Promise<void> {
    const [rsvps, invites] = await Promise.all([
      this.rsvps.find({
        where: {
          eventId: event.id,
          status: In([
            RsvpStatus.Going,
            RsvpStatus.Maybe,
            RsvpStatus.Waitlisted,
          ]),
        },
      }),
      this.invites.find({ where: { eventId: event.id } }),
    ]);
    const recipientIds = [
      ...new Set([
        ...rsvps.map((rsvp) => rsvp.userId),
        ...invites.map((invite) => invite.inviteeId),
      ]),
    ].filter((recipientId) => recipientId !== editorId);
    if (recipientIds.length === 0) return;
    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.EventUpdated,
      {
        eventId: event.id,
        // Carried so the MyEvents "What's changed" panel can deep-link the row
        // to the event card (the client keys events by slug, not uuid).
        eventSlug: event.slug,
        title: event.title,
        startAt: event.startAt.toISOString(),
        changes,
      },
    );
  }

  /**
   * `scope` (MSG-10) — `'future'` also cancels every LATER, not-yet-cancelled
   * occurrence in the same series (mirrors `update()`'s scope semantics
   * exactly, including skipping the per-sibling organizer re-check — see its
   * doc). `'this'` (the default) is unchanged prior behavior.
   */
  async cancel(
    slug: string,
    userId: string,
    scope: SeriesScope = 'this',
  ): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, userId);

    // Resolve the whole set FIRST, then flip it in one statement. The loop this
    // replaced saved each occurrence and fanned its notifications out before
    // moving to the next, so a throw part-way through left the series half
    // cancelled with no rollback: some attendees had already been told the
    // gathering was off while later occurrences still read as published, and
    // the host got an error with no way to tell which was which.
    const futureSiblings =
      scope === 'future' && event.seriesId && event.seriesIndex !== null
        ? await this.events.find({
            where: {
              seriesId: event.seriesId,
              seriesIndex: MoreThan(event.seriesIndex),
              status: Not(EventStatus.Cancelled),
            },
          })
        : [];
    const cancelled = [event, ...futureSiblings];
    await this.events.update(
      { id: In(cancelled.map((occurrence) => occurrence.id)) },
      { status: EventStatus.Cancelled },
    );
    for (const occurrence of cancelled) {
      occurrence.status = EventStatus.Cancelled;
    }

    // Fan out AFTER the status is committed; mirrors EventRemindersService.
    for (const occurrence of cancelled) {
      await this.notifyEventCancelled(occurrence, userId);
    }

    return this.buildDetail(event, userId);
  }

  // Tell attendees one occurrence is off. Recipients = anyone with a live RSVP
  // (going/maybe/waitlisted), minus the organizer who just cancelled it.
  private async notifyEventCancelled(
    event: Event,
    userId: string,
  ): Promise<void> {
    const rsvps = await this.rsvps.find({
      where: {
        eventId: event.id,
        status: In([RsvpStatus.Going, RsvpStatus.Maybe, RsvpStatus.Waitlisted]),
      },
    });
    const recipientIds = rsvps
      .map((r) => r.userId)
      .filter((id) => id !== userId);
    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.EventCancelled,
      {
        eventId: event.id,
        // Carried so the MyEvents panel can deep-link the row (client keys by slug).
        eventSlug: event.slug,
        title: event.title,
        startAt: event.startAt.toISOString(),
      },
    );
  }

  /**
   * `options.hostSlug`/`excludeSlug` are honoured on the 'upcoming' branch
   * only — see `ListEventsQuery`'s doc.
   *
   * `options.from`/`to`/`hood`/`type`/`q`/`cost` are the discovery filters
   * (LOC-17). They are applied IN SQL, never post-query, so a filtered browse
   * survives pagination: the old shape shipped whole pages to the client and
   * filtered them there, which under-reported every answer until the member
   * had scrolled the entire feed. `from`/`to`/`q` also apply to the 'past'
   * branch (a member narrowing their own history); the rest are browse-only,
   * and every one is ignored by `going`/`hosting`/`waitlisted`/`saved`, which
   * are already scoped by the viewer's own relationship to the event.
   */
  async list(
    userId: string,
    filter: EventListFilter,
    page: number,
    options?: {
      hostSlug?: string;
      excludeSlug?: string;
      from?: string;
      to?: string;
      hood?: string;
      type?: string;
      q?: string;
      cost?: EventCostFilter;
    },
  ): Promise<EventSummary[]> {
    const now = new Date();
    const skip = (page - 1) * PAGE_SIZE;
    let events: Event[];

    if (filter === 'hosting') {
      const cohosted = await this.cohosts.find({ where: { userId } });
      const ids = cohosted.map((c) => c.eventId);
      events = await this.events.find({
        where: [{ hostId: userId }, ...(ids.length ? [{ id: In(ids) }] : [])],
        order: { startAt: 'DESC' },
        take: PAGE_SIZE,
        skip,
      });
    } else if (filter === 'going' || filter === 'waitlisted') {
      // One join instead of "fetch my rsvp ids, then fetch events". Paginated.
      const status =
        filter === 'going' ? RsvpStatus.Going : RsvpStatus.Waitlisted;
      events = await this.events
        .createQueryBuilder('e')
        .innerJoin(EventRsvp, 'r', 'r.event_id = e.id')
        .where('r.user_id = :userId', { userId })
        .andWhere('r.status = :status', { status })
        // Property path (`startAt`), not the DB column: with the join + skip/take
        // this goes through TypeORM's distinct-id pagination pass, which resolves
        // ORDER BY via `findColumnWithPropertyPath` and throws on a raw column.
        .orderBy('e.startAt', 'ASC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    } else if (filter === 'past') {
      // Single join: my non-cancelled RSVPs to events that have already started.
      const pastQb = this.events
        .createQueryBuilder('e')
        .innerJoin(EventRsvp, 'r', 'r.event_id = e.id')
        .where('r.user_id = :userId', { userId })
        .andWhere('r.status IN (:...statuses)', {
          statuses: [RsvpStatus.Going, RsvpStatus.Maybe, RsvpStatus.Waitlisted],
        })
        .andWhere('e.start_at < :now', { now });
      this.applyDiscoveryFilters(pastQb, {
        from: options?.from,
        to: options?.to,
        q: options?.q,
      });
      events = await pastQb
        // Property path (`startAt`) — see the join+pagination note above.
        .orderBy('e.startAt', 'DESC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    } else if (filter === 'saved') {
      // The member's bookmarked ("saved") events, most-recently-saved first.
      // One indexed join over `event_bookmarks`, paginated — the same shape as
      // the `going`/`waitlisted` branches above. (Was an honest empty stub until
      // the `event_bookmarks` entity landed — see BE-3.)
      events = await this.bookmarks.listSaved(userId, skip, PAGE_SIZE);
    } else {
      // 'upcoming' — published, future, public/members, plus network/community
      // gatherings the viewer's own gate admits (invite_only still surfaces
      // only via going/hosting/invited contexts, not the general browse; see
      // `EventAudienceGateService.scopedVisibilityWhere` for why
      // extended_network stays excluded too).
      const { clause: visibilityClause, params: visibilityParams } =
        await this.audienceGate.scopedVisibilityWhere(userId);
      const upcomingQb = this.events
        .createQueryBuilder('e')
        .where('e.status = :status', { status: EventStatus.Published })
        .andWhere('e.start_at >= :now', { now })
        .andWhere(visibilityClause, visibilityParams);
      this.excludeModeratedEvents(upcomingQb);
      if (options?.hostSlug) {
        const hostProfile = await this.profiles.findOne({
          where: { slug: options.hostSlug },
        });
        // No such member -> a uuid that can never match, so the filter fails
        // closed (an empty result) instead of silently falling back to the
        // unfiltered upcoming feed.
        upcomingQb.andWhere('e.host_id = :hostId', {
          hostId: hostProfile?.userId ?? '00000000-0000-0000-0000-000000000000',
        });
      }
      if (options?.excludeSlug) {
        upcomingQb.andWhere('e.slug != :excludeSlug', {
          excludeSlug: options.excludeSlug,
        });
      }
      this.applyDiscoveryFilters(upcomingQb, options ?? {});
      events = await upcomingQb
        .orderBy('e.start_at', 'ASC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    }

    return this.summarize(events, userId);
  }

  /**
   * The LOC-17 discovery predicates, all in SQL.
   *
   * `hood` and `type` compare `lower(...)` on both sides rather than using
   * ILIKE, so "arroios" finds "Arroios" while "roio" finds nothing: these are
   * picked from a fixed list, and a substring match on a chosen value would
   * quietly widen the filter the member set.
   *
   * `q` reuses `searchByText`'s ILIKE shape (and therefore the trigram
   * indexes `AddSearchTrgmAndTagsIndexes1785700100000` already built on
   * `title`/`venue`/`description`), plus `neighbourhood` so typing a
   * neighbourhood name into the search box works the way a member expects.
   *
   * `cost` reads the free-text column the way `isFreeCost` does. The two must
   * agree, or a card would carry a "free" chip that the free filter excludes.
   * `NULL`/empty counts as free: every gathering created before the column
   * existed was free as far as this platform ever knew.
   */
  private applyDiscoveryFilters(
    qb: SelectQueryBuilder<Event>,
    options: {
      from?: string;
      to?: string;
      hood?: string;
      type?: string;
      q?: string;
      cost?: EventCostFilter;
    },
  ): void {
    if (options.from) {
      const from = new Date(options.from);
      if (!Number.isNaN(from.getTime())) {
        qb.andWhere('e.start_at >= :discoveryFrom', { discoveryFrom: from });
      }
    }
    if (options.to) {
      const to = new Date(options.to);
      if (!Number.isNaN(to.getTime())) {
        qb.andWhere('e.start_at <= :discoveryTo', { discoveryTo: to });
      }
    }
    if (options.hood) {
      qb.andWhere('lower(e.neighbourhood) = lower(:discoveryHood)', {
        discoveryHood: options.hood.trim(),
      });
    }
    if (options.type) {
      qb.andWhere('lower(e.event_type) = lower(:discoveryType)', {
        discoveryType: options.type.trim(),
      });
    }
    const term = options.q?.trim();
    if (term) {
      qb.andWhere(
        '(e.title ILIKE :discoveryPattern OR e.venue ILIKE :discoveryPattern ' +
          'OR e.neighbourhood ILIKE :discoveryPattern ' +
          'OR e.description ILIKE :discoveryPattern)',
        { discoveryPattern: `%${escapeLikeTerm(term)}%` },
      );
    }
    if (options.cost === 'free') {
      qb.andWhere(
        `(e.cost IS NULL OR btrim(e.cost) = '' OR lower(btrim(e.cost)) = ANY(:freeCostLabels))`,
        { freeCostLabels: EventsService.FREE_COST_LABELS },
      );
    } else if (options.cost === 'paid') {
      qb.andWhere(
        `(e.cost IS NOT NULL AND btrim(e.cost) <> '' AND NOT (lower(btrim(e.cost)) = ANY(:freeCostLabels)))`,
        { freeCostLabels: EventsService.FREE_COST_LABELS },
      );
    }
  }

  // The SQL half of `isFreeCost` (event-response.ts). Kept beside the query
  // that uses it and asserted equal to the TypeScript half by
  // `events-discovery.spec.ts`, so the chip on a card and the filter that
  // produced the card cannot drift apart.
  private static readonly FREE_COST_LABELS = [
    'free',
    'gratis',
    'gratuito',
    'grátis',
    'free entry',
    'entrada livre',
    'entrada gratuita',
    '0',
    '0 eur',
    '0eur',
    'no cost',
  ];

  // '' and '   ' are "the host skipped this field", never a zero-length
  // street name. One place, so create() and update() cannot disagree.
  private static blankToNull(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  // Cross-entity global search (SearchService) — mirrors the 'upcoming'
  // branch's visibility (public/members, plus the viewer's own network/
  // community gatherings) but drops the `start_at >= now` restriction so past
  // matches still surface. ILIKE over title / venue / description.
  async searchByText(
    userId: string,
    term: string,
    limit: number,
  ): Promise<EventSummary[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const { clause: visibilityClause, params: visibilityParams } =
      await this.audienceGate.scopedVisibilityWhere(userId);
    const searchQb = this.events
      .createQueryBuilder('e')
      .where('e.status = :status', { status: EventStatus.Published })
      .andWhere(visibilityClause, visibilityParams)
      .andWhere(
        '(e.title ILIKE :pattern OR e.venue ILIKE :pattern OR e.description ILIKE :pattern)',
        { pattern },
      );
    this.excludeModeratedEvents(searchQb);
    const events = await searchQb
      .orderBy('e.start_at', 'DESC')
      .take(limit)
      .getMany();

    return this.summarize(events, userId);
  }

  async addCohost(
    slug: string,
    actorId: string,
    cohostSlug: string,
  ): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const profile = await this.profiles.findOne({
      where: { slug: cohostSlug },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    const cohostUser = await this.usersService.findById(profile.userId);
    if (!cohostUser || cohostUser.status !== UserStatus.Active) {
      throw new BadRequestException('Co-hosts must be active members');
    }
    await this.addCohostByUserId(event.id, profile.userId);
    return { ok: true };
  }

  /**
   * The actual `event_cohosts` insert, extracted so both the direct-add path
   * (`addCohost`, organizer-authorized) and the cohost-invite accept path
   * (`EventCohostInvitesService.respond`, authorized by the pending invite
   * itself; the acceptor need not be an organizer) share one place
   * that writes the roster row. Idempotent (`ON CONFLICT DO NOTHING`): a
   * no-op for the host, who is already an implicit organizer.
   */
  async addCohostByUserId(
    eventId: string,
    userId: string,
    // Optional so the invite-accept path can run this insert inside the SAME
    // transaction that flips the invite to `accepted` — the two writes have to
    // land together or not at all, or an accepted invite can end up with no
    // roster row and no way to retry (accepting twice 409s).
    manager?: EntityManager,
  ): Promise<void> {
    const eventRepository = manager
      ? manager.getRepository(Event)
      : this.events;
    const cohostRepository = manager
      ? manager.getRepository(EventCohost)
      : this.cohosts;
    const event = await eventRepository.findOne({ where: { id: eventId } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (userId === event.hostId) {
      return;
    }
    await cohostRepository
      .createQueryBuilder()
      .insert()
      .into(EventCohost)
      .values({ eventId, userId })
      .orIgnore()
      .execute();
  }

  async removeCohost(
    slug: string,
    actorId: string,
    cohostSlug: string,
  ): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const profile = await this.profiles.findOne({
      where: { slug: cohostSlug },
    });
    if (profile) {
      await this.cohosts.delete({
        eventId: event.id,
        userId: profile.userId,
      });
    }
    return { ok: true };
  }

  /**
   * Host/co-host-only replace-all of an event's lineup ("who performed").
   * Mirrors `SubprofilesService.replaceAffiliations`'s shape: resolve +
   * validate every target BEFORE writing anything (batched, one `IN` query,
   * not a `findOne` per entry), then delete-and-recreate inside one
   * transaction so a caller never observes a partially-replaced lineup.
   * Duplicate `memberSlug`s in the same call collapse to one row (last role
   * wins) rather than tripping the `UNIQUE(event_id, user_id)` constraint.
   */
  async replaceLineup(
    slug: string,
    actorId: string,
    entries: LineupEntryInput[],
  ): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);

    if (entries.length > MAX_LINEUP_ENTRIES) {
      throw new BadRequestException(
        `A lineup can have at most ${MAX_LINEUP_ENTRIES} entries`,
      );
    }

    const memberSlugs = [...new Set(entries.map((entry) => entry.memberSlug))];
    const profiles = memberSlugs.length
      ? await this.profiles.find({ where: { slug: In(memberSlugs) } })
      : [];
    const profileBySlug = new Map(profiles.map((p) => [p.slug, p]));

    for (const entry of entries) {
      if (!profileBySlug.has(entry.memberSlug)) {
        throw new NotFoundException(`Member not found: ${entry.memberSlug}`);
      }
    }

    const rowsByUserId = new Map<string, { userId: string; role: string }>();
    for (const entry of entries) {
      const profile = profileBySlug.get(entry.memberSlug);
      if (!profile) continue; // unreachable — validated above
      rowsByUserId.set(profile.userId, {
        userId: profile.userId,
        role: entry.role,
      });
    }

    await this.lineupEntries.manager.transaction(async (manager) => {
      await manager.delete(EventLineupEntry, { eventId: event.id });
      const rows = [...rowsByUserId.values()].map((row) =>
        manager.create(EventLineupEntry, {
          eventId: event.id,
          userId: row.userId,
          role: row.role,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });

    return this.buildLineupDTO(event.id, actorId);
  }

  // Same visibility gate as `attendees` — a draft/invite-only/taken-down
  // event 404s for a non-organizer viewer rather than leaking its lineup.
  async getLineup(slug: string, viewerId: string): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertCanView(event, viewerId);
    return this.buildLineupDTO(event.id, viewerId);
  }

  private async buildLineupDTO(
    eventId: string,
    viewerId: string,
  ): Promise<EventLineupDTO> {
    const rows = await this.lineupEntries.find({
      where: { eventId },
      order: { createdAt: 'ASC' },
    });
    const profiles = await this.profilesByUserIds(rows.map((r) => r.userId));
    const entries = rows
      .map((row) => toLineupEntryView(row, profiles.get(row.userId)))
      .filter((view): view is NonNullable<typeof view> => view !== null);
    const viewerRow = rows.find((row) => row.userId === viewerId);
    const viewerEntry = viewerRow
      ? toLineupEntryView(viewerRow, profiles.get(viewerRow.userId))
      : null;
    return { entries, viewerEntry };
  }

  /**
   * One RSVP status's own paginated page (`going` or `waitlisted`) — never
   * the whole guest list in one response. This used to be
   * `this.rsvps.find({ where: { eventId } })` with no `LIMIT` at all: an
   * uncapped (`capacity: null`) public gathering could accumulate an
   * unbounded number of `going` rows, all fetched (and post-query filtered)
   * on every dashboard load. `status` splits the single combined list into
   * the two the manage dashboard actually renders, and `paginate` bounds each
   * to `PAGE_SIZE` per page.
   */
  async attendees(
    slug: string,
    viewerId: string,
    status: AttendeeStatusFilter,
    page?: number,
  ): Promise<AttendeesPageDTO> {
    const event = await this.loadEventOr404(slug);
    const isOrganizer = await this.assertCanView(event, viewerId);
    const normalizedPage = normalizePage(page);
    const rsvpStatus =
      status === 'waitlisted' ? RsvpStatus.Waitlisted : RsvpStatus.Going;

    const qb = this.rsvps
      .createQueryBuilder('r')
      .where('r.event_id = :eventId', { eventId: event.id })
      .andWhere('r.status = :status', { status: rsvpStatus })
      .orderBy('r.waitlist_position', 'ASC')
      .addOrderBy('r.created_at', 'ASC');
    // Blocks only — deliberately NOT mutes. A block is a mutual severance, so
    // a blocked member must not surface in a list the viewer reads (same rule
    // `ProfilesService.searchMembers` applies to the directory). A mute is a
    // content-feed silence, not an "erase them from the guest list" tool:
    // dropping muted members here would misstate who is actually attending,
    // which the viewer may need to know for their own safety planning.
    // In-query (not the old post-query filter) so a page of `PAGE_SIZE`
    // attendees comes back full instead of silently short.
    this.blockFilter.excludeBlocked(qb, viewerId, '"r"."user_id"');

    const {
      items,
      total,
      page: resolvedPage,
      pageSize,
    } = await paginate(qb, normalizedPage, async (rows) => {
      if (!rows.length) return [];
      const profiles = await this.profilesByUserIds(rows.map((r) => r.userId));
      return rows
        .filter((r) => profiles.has(r.userId)) // drop profile-less ghost rows
        .map((r) => {
          // ORGANISERS ONLY for the check-in stamp and the attendee's own
          // declared needs (LOC-07/LOC-03) — `toAttendeeView` omits all four
          // fields entirely for anybody else, and this route is never
          // `@Public()`.
          const view = toAttendeeView(r, profiles.get(r.userId), isOrganizer);
          // Waitlist ordering is organizer-only; hide positions from regular viewers.
          if (!isOrganizer) {
            view.waitlistPosition = null;
          }
          return view;
        });
    });

    const counts = await this.rosterCounts(event.id);
    return {
      items,
      total,
      page: resolvedPage,
      pageSize,
      capacity: event.capacity,
      goingCount: counts.goingCount,
      seatsTaken: counts.seatsTaken,
      waitlistCount: counts.waitlistCount,
      // Who has physically arrived is the host's own operational picture;
      // a member reading a guest list never learns it.
      checkedInCount: isOrganizer ? counts.checkedInCount : 0,
    };
  }

  /**
   * The four numbers the door needs, in one query: how many members are
   * going, how many SEATS that is once declared guests are counted, how many
   * are waiting, and how many have been checked in (LOC-03/LOC-07).
   *
   * Public because `EventCheckInService` returns the same block after every
   * check-in, and two places computing "expected vs arrived" from two
   * different definitions is exactly how a door desk ends up arguing with a
   * dashboard.
   */
  async rosterCounts(eventId: string): Promise<{
    goingCount: number;
    seatsTaken: number;
    waitlistCount: number;
    checkedInCount: number;
  }> {
    const row = await this.rsvps
      .createQueryBuilder('r')
      .select(`COUNT(*) FILTER (WHERE r.status = :going)`, 'goingCount')
      .addSelect(
        `COUNT(*) FILTER (WHERE r.status = :going) + COALESCE(SUM(r.guest_count) FILTER (WHERE r.status = :going), 0)`,
        'seatsTaken',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE r.status = :waitlisted)`,
        'waitlistCount',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE r.status = :going AND r.checked_in_at IS NOT NULL)`,
        'checkedInCount',
      )
      .where('r.event_id = :eventId', { eventId })
      .setParameters({
        going: RsvpStatus.Going,
        waitlisted: RsvpStatus.Waitlisted,
      })
      .getRawOne<{
        goingCount: string;
        seatsTaken: string;
        waitlistCount: string;
        checkedInCount: string;
      }>();
    return {
      goingCount: Number(row?.goingCount ?? 0),
      seatsTaken: Number(row?.seatsTaken ?? 0),
      waitlistCount: Number(row?.waitlistCount ?? 0),
      checkedInCount: Number(row?.checkedInCount ?? 0),
    };
  }

  /**
   * `GET /communities/:slug/pulse`'s events lane — a community's own
   * upcoming (published, future-dated) gatherings, soonest-first. Unlike
   * `list('upcoming', ...)`, this is scoped to one community by id (not the
   * viewer's own audience-gated browse), so it skips `audienceGate` and
   * `excludeModeratedEvents` entirely: a community's own page showing its
   * own tagged events isn't the public discovery surface those two guard.
   * Card shaping (`toEventSummary`) is reused as-is; `myRsvpStatus` and
   * `isBookmarked` are viewer-less here (always `null`/`false`) since this
   * method isn't called with a specific viewer in mind — see
   * `CommunityPulseService`, which calls this once per pulse request.
   */
  async listUpcomingByCommunity(
    communityId: string,
    limit = 5,
  ): Promise<EventSummary[]> {
    const now = new Date();
    const events = await this.events.find({
      where: {
        communityId,
        status: EventStatus.Published,
        startAt: MoreThanOrEqual(now),
      },
      order: { startAt: 'ASC' },
      take: limit,
    });
    if (!events.length) return [];

    const eventIds = events.map((e) => e.id);
    const goingRows = await this.rsvps
      .createQueryBuilder('r')
      .select('r.event_id', 'eventId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COUNT(*) + COALESCE(SUM(r.guest_count), 0)', 'seats')
      .where('r.event_id IN (:...ids)', { ids: eventIds })
      .andWhere('r.status = :status', { status: RsvpStatus.Going })
      .groupBy('r.event_id')
      .getRawMany<{ eventId: string; count: string; seats: string }>();
    const goingByEvent = new Map(
      goingRows.map((row) => [row.eventId, Number(row.count)]),
    );
    const seatsByEvent = new Map(
      goingRows.map((row) => [row.eventId, Number(row.seats)]),
    );
    const crops = await this.mediaCropService.getMany(
      events.flatMap((e) => (e.coverImageUrl ? [e.coverImageUrl] : [])),
    );
    const hostProfiles = await this.profilesByUserIds(
      // NULL for a gathering whose host erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`); the row stays,
      // and `toOrganizerView(undefined)` renders `host: null`.
      presentActorIds(events.map((e) => e.hostId)),
    );

    return events.map((e) =>
      toEventSummary(
        e,
        goingByEvent.get(e.id) ?? 0,
        null,
        false,
        crops,
        toOrganizerView(actorFromLookup(hostProfiles, e.hostId)),
        undefined,
        seatsByEvent.get(e.id) ?? 0,
      ),
    );
  }

  async isOrganizer(eventId: string, userId: string): Promise<boolean> {
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event) return false;
    if (event.hostId === userId) return true;
    return this.cohosts.exists({ where: { eventId, userId } });
  }

  // --- internals ---

  private async assertOrganizer(
    eventId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.isOrganizer(eventId, userId))) {
      throw new ForbiddenException('Only the host or a co-host can do that');
    }
  }

  // Enforces read visibility and returns whether the viewer is an organizer (so
  // callers can reuse the fact without a second lookup). Non-viewable events are
  // reported as 404 rather than 403 so their existence isn't leaked.
  private async assertCanView(
    event: Event,
    viewerId: string,
  ): Promise<boolean> {
    const isOrganizer = await this.isOrganizer(event.id, viewerId);
    // A moderator takedown 404s the detail for everyone but an organizer — same
    // "don't leak existence" posture as the draft/invite-only gates below.
    if (!isOrganizer) {
      const moderation = await this.contentModeration.stateFor(
        EventsService.SUBJECT_TYPE,
        event.id,
      );
      if (moderation.hidden || moderation.removed) {
        throw new NotFoundException('Event not found');
      }
    }
    // Drafts are the organizers' private workspace — invisible to everyone else.
    if (event.status === EventStatus.Draft) {
      if (!isOrganizer) {
        throw new NotFoundException('Event not found');
      }
      return isOrganizer;
    }
    // Every scoped-visibility tier (invite_only, network, extended_network,
    // community) shares ONE gate with the RSVP write path — see
    // `EventAudienceGateService`'s class doc for why this used to be (and
    // must not again become) two places that can drift.
    await this.audienceGate.assertViewable(event, viewerId, isOrganizer);
    return isOrganizer;
  }

  private assertScheduleValid(
    startAt: Date,
    endAt: Date | null,
    opts: { rejectPast: boolean },
  ): void {
    if (opts.rejectPast && startAt.getTime() < Date.now()) {
      throw new BadRequestException('startAt must be in the future');
    }
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('endAt must be after startAt');
    }
  }

  /**
   * Resolves a `listingId` payload value to a validated attach target. 400s
   * (not 404; this is a create/update input, not a route lookup) when it isn't
   * a real, live, linkable listing. Mirrors `assertMemberBySlug`'s "resolve +
   * authorize, or throw" shape for `communitySlug`, and returns the full ref
   * so the caller can ask the venue's owner for consent (LOC-16).
   *
   * THE SECOND CHECK IS THE POINT (LOC-16). A venue owner who detaches a
   * gathering from their business has said no, and without this the host could
   * simply re-attach it, making "the owner can detach" mean "the owner can
   * detach for five seconds". Refused for that listing and that gathering
   * only: the host stays free to name any other venue, or to write the same
   * venue's name into the free-text `venue` field, which is their own
   * statement about where to go and never appears on the business's page.
   */
  private async assertAttachableListing(
    listingId: string,
    event?: Event,
  ): Promise<AttachableListingRef> {
    if (event && event.venueDetachedListingId === listingId) {
      throw new BadRequestException(
        'This venue removed this gathering from its page',
      );
    }
    const listing = await this.listingLookup.findAttachable(listingId);
    if (!listing) {
      throw new BadRequestException('Venue listing not found');
    }
    return listing;
  }

  private async loadEventOr404(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async summarize(
    events: Event[],
    userId: string,
  ): Promise<EventSummary[]> {
    if (!events.length) return [];
    const eventIds = events.map((e) => e.id);

    // One grouped count for every event's going tally, carrying BOTH numbers
    // in a single pass: the headcount of members who pressed the button, and
    // the seats they actually occupy once their declared guests are added.
    // Capacity is measured against the second (LOC-07).
    const goingRows = await this.rsvps
      .createQueryBuilder('r')
      .select('r.event_id', 'eventId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COUNT(*) + COALESCE(SUM(r.guest_count), 0)', 'seats')
      .where('r.event_id IN (:...ids)', { ids: eventIds })
      .andWhere('r.status = :status', { status: RsvpStatus.Going })
      .groupBy('r.event_id')
      .getRawMany<{ eventId: string; count: string; seats: string }>();
    const goingByEvent = new Map(
      goingRows.map((row) => [row.eventId, Number(row.count)]),
    );
    const seatsByEvent = new Map(
      goingRows.map((row) => [row.eventId, Number(row.seats)]),
    );

    // ...and one IN-query for the viewer's own RSVP across the whole page.
    const myRsvps = await this.rsvps.find({
      where: { eventId: In(eventIds), userId },
    });
    const myRsvpByEvent = new Map(myRsvps.map((r) => [r.eventId, r]));

    // ...and one IN-query for which of the page's events the viewer bookmarked.
    const bookmarkedIds = await this.bookmarks.bookmarkedEventIds(
      userId,
      eventIds,
    );
    // ...and ONE batched crop lookup for every event's cover on the page —
    // never a per-event query.
    const crops = await this.mediaCropService.getMany(
      events.flatMap((e) => (e.coverImageUrl ? [e.coverImageUrl] : [])),
    );
    // ...and ONE batched host-profile lookup — see `EventSummary.host`'s doc
    // for why the list surface carries a real host ref now, not just an org
    // label (MyEvents' "Block host" flow needs the host's own member slug).
    const hostProfiles = await this.profilesByUserIds(
      // NULL for a gathering whose host erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`); the row stays,
      // and `toOrganizerView(undefined)` renders `host: null`.
      presentActorIds(events.map((e) => e.hostId)),
    );
    // ...and ONE batched series lookup for every recurring event on the page
    // (see `EventSummary.series`'s doc) — never a per-event query.
    const seriesById = await this.eventSeriesByIds(
      events.flatMap((e) => (e.seriesId ? [e.seriesId] : [])),
    );

    return events.map((e) =>
      toEventSummary(
        e,
        goingByEvent.get(e.id) ?? 0,
        myRsvpByEvent.get(e.id) ?? null,
        bookmarkedIds.has(e.id),
        crops,
        toOrganizerView(actorFromLookup(hostProfiles, e.hostId)),
        e.seriesId ? seriesById.get(e.seriesId) : undefined,
        seatsByEvent.get(e.id) ?? 0,
      ),
    );
  }

  private async eventSeriesByIds(
    seriesIds: string[],
  ): Promise<Map<string, EventSeries>> {
    const uniqueIds = [...new Set(seriesIds)];
    if (!uniqueIds.length) return new Map();
    const rows = await this.eventSeries.find({ where: { id: In(uniqueIds) } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async buildDetail(
    event: Event,
    viewerId: string,
  ): Promise<EventDetail> {
    // First wave: these six lookups are all independent of one another — only
    // `profilesByUserIds` below depends on `cohostRows`'s ids, so it waits for
    // its own second wave instead of chaining behind every other await.
    // `communitySlug` is a single-event lookup (this method builds one
    // event's detail, never a list page), so riding along here costs nothing
    // extra on the hot list/browse path — see `EventSummary.communityId` vs.
    // `EventDetail.communitySlug`'s doc comments for why the split.
    const [
      goingCount,
      waitlistCount,
      myRsvp,
      cohostRows,
      isBookmarked,
      communitySlug,
      crops,
      venueListing,
      series,
      seatCounts,
      announcementRows,
    ] = await Promise.all([
      this.rsvps.count({
        where: { eventId: event.id, status: RsvpStatus.Going },
      }),
      this.rsvps.count({
        where: { eventId: event.id, status: RsvpStatus.Waitlisted },
      }),
      this.rsvps.findOne({
        where: { eventId: event.id, userId: viewerId },
      }),
      this.cohosts.find({
        where: { eventId: event.id },
      }),
      this.bookmarks.isBookmarked(viewerId, event.id),
      event.communityId
        ? this.membership.slugById(event.communityId)
        : Promise.resolve(null),
      this.mediaCropService.getMany(
        event.coverImageUrl ? [event.coverImageUrl] : [],
      ),
      event.listingId
        ? this.listingLookup.findLive(event.listingId)
        : Promise.resolve(null),
      event.seriesId
        ? this.eventSeries.findOne({ where: { id: event.seriesId } })
        : Promise.resolve(undefined),
      this.rosterCounts(event.id),
      // Newest first, bounded — a host's announcements are a short list of
      // "we moved to the back room" notes, never a feed.
      this.announcements.find({
        where: { eventId: event.id },
        order: { createdAt: 'DESC' },
        take: EventsService.ANNOUNCEMENT_DETAIL_LIMIT,
      }),
    ]);
    const organizerIds = presentActorIds([
      event.hostId,
      ...cohostRows.map((c) => c.userId),
    ]);
    const profiles = await this.profilesByUserIds(organizerIds);
    const isOrganizer =
      event.hostId === viewerId ||
      cohostRows.some((c) => c.userId === viewerId);
    const attendeesPreview = await this.buildGoingAttendeesPreview(
      event,
      viewerId,
      isOrganizer,
    );

    const summary = toEventSummary(
      event,
      goingCount,
      myRsvp ?? null,
      isBookmarked,
      crops,
      null,
      series ?? undefined,
      seatCounts.seatsTaken,
    );

    // ADDRESS PRIVACY (LOC-04). The exact door goes to an organiser or to
    // somebody holding a CONFIRMED 'going' RSVP, and to nobody else: a
    // 'maybe' has not committed, a waitlisted member has no seat yet, and a
    // stranger browsing gets the venue name and the neighbourhood. This is
    // the same shape `toHousingListingDTO` applies to a home's precise point,
    // for the same reason: a house party has to be listable without its
    // address being public.
    const hasConfirmedRsvp = myRsvp?.status === RsvpStatus.Going;
    const seesExactLocation = isOrganizer || hasConfirmedRsvp;

    // Announcements reach the people they were addressed to: organisers, and
    // anyone holding a live RSVP of any kind (going, maybe or waitlisted —
    // "we moved to the back room" matters to all three). A passer-by reading
    // the public page gets none.
    const seesAnnouncements =
      isOrganizer ||
      (myRsvp !== null &&
        myRsvp !== undefined &&
        myRsvp.status !== RsvpStatus.Cancelled);
    const announcementAuthors = seesAnnouncements
      ? await this.profilesByUserIds(
          presentActorIds(announcementRows.map((row) => row.authorId)),
        )
      : new Map<string, Profile>();

    return {
      ...summary,
      description: event.description,
      onlineUrl: event.onlineUrl,
      address: seesExactLocation ? event.address : null,
      arrivalNotes: seesExactLocation ? event.arrivalNotes : null,
      locationPrecision:
        seesExactLocation && event.address !== null ? 'exact' : 'venue',
      language: event.language,
      accessibilityAnswers: normalizeAccessibilityAnswers(
        event.accessibilityAnswers,
      ),
      accessibilityNote: event.accessibilityNote ?? '',
      announcements: seesAnnouncements
        ? announcementRows.map((row) =>
            toEventAnnouncementView(
              row,
              row.authorId ? announcementAuthors.get(row.authorId) : undefined,
            ),
          )
        : [],
      communitySlug,
      venueListing,
      // LOC-16. Organisers only, and only when there is (or was) a listed
      // venue to describe. See `EventDetail.venueAttachment`.
      ...(isOrganizer
        ? { venueAttachment: toEventVenueAttachmentView(event) }
        : {}),
      host: toOrganizerView(actorFromLookup(profiles, event.hostId)),
      cohosts: cohostRows
        .map((c) => toOrganizerView(profiles.get(c.userId)))
        .filter((v): v is NonNullable<typeof v> => v !== null),
      isOrganizer,
      waitlistCount,
      myWaitlistPosition: myRsvp?.waitlistPosition ?? null,
      showAttendeeCount: event.showAttendeeCount,
      allowWaitlist: event.allowWaitlist,
      myRsvpDetails:
        myRsvp && myRsvp.status !== RsvpStatus.Cancelled
          ? toRsvpDetailsView(myRsvp)
          : null,
      goingAttendeesPreview: attendeesPreview.attendees,
      goingAttendeesPreviewTotal: attendeesPreview.total,
    };
  }

  /** At most this many announcements ride on `EventDetail.announcements`.
   *  The full list is `GET /events/:slug/announcements`. */
  private static readonly ANNOUNCEMENT_DETAIL_LIMIT = 10;

  // At most this many profiles ride on `EventDetail.goingAttendeesPreview` —
  // a small pre-RSVP "safety in numbers" glance, not the full guest list
  // (that's `attendees()`, paginated, organizer-facing).
  private static readonly ATTENDEE_PREVIEW_LIMIT = 8;

  /**
   * MSG-12 — `EventDetail.goingAttendeesPreview`'s query. Two privacy layers,
   * same primitives `attendees()` already uses:
   *  - `Event.showAttendeeCount` (MSG-18 "Show attendee count" toggle): when
   *    the host has turned it off, a non-organizer viewer gets no preview at
   *    all — same signal the FE's numeric "spots" copy already hides behind
   *    this flag (`detailToGathering`'s `hideCount`). The organizer's own
   *    view is unaffected; the toggle only hides the signal from others.
   *  - Blocks (not mutes) via `BlockFilterService.excludeBlocked` — a blocked/
   *    blocking member must never surface here in either direction. See
   *    `attendees()`'s own doc for why blocks (not mutes) are the right
   *    primitive for a guest list.
   * There is currently no per-member "hide me from attendee lists" opt-out
   * anywhere in this codebase (checked `Profile` and every existing privacy
   * toggle) — only the event-level toggle above exists to honor today.
   */
  private async buildGoingAttendeesPreview(
    event: Event,
    viewerId: string,
    isOrganizer: boolean,
  ): Promise<{ attendees: EventOrganizerView[]; total: number }> {
    if (!event.showAttendeeCount && !isOrganizer) {
      return { attendees: [], total: 0 };
    }

    const qb = this.rsvps
      .createQueryBuilder('r')
      .where('r.event_id = :eventId', { eventId: event.id })
      .andWhere('r.status = :status', { status: RsvpStatus.Going })
      .orderBy('r.created_at', 'ASC');
    this.blockFilter.excludeBlocked(qb, viewerId, '"r"."user_id"');

    const total = await qb.getCount();
    if (total === 0) return { attendees: [], total: 0 };

    const rows = await qb.take(EventsService.ATTENDEE_PREVIEW_LIMIT).getMany();
    const profiles = await this.profilesByUserIds(rows.map((r) => r.userId));
    const attendees = rows
      .map((r) => toOrganizerView(profiles.get(r.userId)))
      .filter((view): view is NonNullable<typeof view> => view !== null);
    return { attendees, total };
  }

  private async profilesByUserIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) return new Map();
    const found = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    return new Map(found.map((p) => [p.userId, p]));
  }

  // Assigns a unique slug and persists, retrying on the (rare) race where a
  // concurrent create grabs the same slug between the pre-check and this INSERT.
  private async saveWithUniqueSlug(
    event: Event,
    title: string,
  ): Promise<Event> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      event.slug = await this.generateUniqueSlug(title);
      try {
        return await this.events.save(event);
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) {
          continue; // lost the slug race — regenerate and retry
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved event or rethrows.
    throw new ConflictException('Could not allocate a unique event slug');
  }

  private async generateUniqueSlug(title: string): Promise<string> {
    const base =
      title
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'event';
    let slug = base;
    while (await this.events.exists({ where: { slug } })) {
      slug = `${base}-${randomBytes(3).toString('hex')}`;
    }
    return slug;
  }
}
