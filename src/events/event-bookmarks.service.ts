import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBookmark } from './entities/event-bookmark.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { Event } from './entities/event.entity';

/**
 * Event bookmarks ("saved events"). Kept out of the already-large
 * `EventsService`; `EventsService` injects this for the read-side helpers it
 * needs (the `saved` list branch + the batch `isBookmarked` flag), and the
 * controller injects it for the write endpoints. This service depends only on
 * repositories and `EventAudienceGateService` (never back on `EventsService`),
 * so it closes no DI cycle — same reasoning `EventAudienceGateService`'s own
 * class doc already lays out for why `EventsService`/`RsvpService` both
 * inject IT rather than one another.
 */
@Injectable()
export class EventBookmarksService {
  constructor(
    @InjectRepository(EventBookmark)
    private readonly bookmarks: Repository<EventBookmark>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    private readonly audienceGate: EventAudienceGateService,
  ) {}

  /**
   * Bookmark an event for the caller. Idempotent: a second bookmark of the same
   * event is absorbed by `ON CONFLICT DO NOTHING` against `UQ_event_bookmarks`,
   * so concurrent double-taps never 23505 — the endpoint always reports the
   * resulting "is bookmarked" truth.
   *
   * Fix round 2 (Task A): gated through `EventAudienceGateService
   * .assertViewable`, the SAME shared audience-scope check
   * `EventsService.assertCanView`/`RsvpService`'s RSVP gate use — a member
   * cannot bookmark an event they cannot view (network/extended_network/
   * community/invite_only all enforced, existence-hiding `NotFoundException`
   * on rejection, exactly like the other two gated paths). `isOrganizer` is
   * computed the same way the RSVP path computes it: host id, or a co-host
   * row.
   */
  async bookmark(userId: string, slug: string): Promise<{ bookmarked: true }> {
    const event = await this.loadEventBySlug(slug);
    const isOrganizer =
      event.hostId === userId ||
      (await this.cohosts.exists({ where: { eventId: event.id, userId } }));
    await this.audienceGate.assertViewable(event, userId, isOrganizer);

    await this.bookmarks
      .createQueryBuilder()
      .insert()
      .into(EventBookmark)
      .values({ eventId: event.id, userId })
      .orIgnore()
      .execute();
    return { bookmarked: true };
  }

  /**
   * Remove the caller's bookmark. Idempotent: removing a bookmark that isn't
   * there is a no-op that still reports the same final state. A missing event
   * 404s (parity with `bookmark`), rather than silently succeeding on a bad
   * slug. Deliberately NOT gated through `assertViewable` — un-saving
   * something the viewer can no longer see (or never should have been able
   * to bookmark, from before this gate existed) must still be possible; only
   * the CREATE direction needs the audience check.
   */
  async removeBookmark(
    userId: string,
    slug: string,
  ): Promise<{ bookmarked: false }> {
    const eventId = await this.resolveEventId(slug);
    await this.bookmarks.delete({ eventId, userId });
    return { bookmarked: false };
  }

  /**
   * The caller's bookmarked events, most-recently-saved first, paginated. One
   * indexed join (`event_bookmarks.event_id = events.id`) — the same shape the
   * `going`/`waitlisted` list branches use — never "fetch bookmark ids, then
   * fetch events".
   *
   * Fix round 3 (Task A, read direction — corrects fix round 2's approach):
   * the page is fetched WITHOUT a visibility predicate, then run through
   * `EventAudienceGateService.filterViewable` — full per-event VIEWABILITY
   * (organizer bypass, invite_only, extended_network, everything
   * `assertViewable` checks), not the cheaper `scopedVisibilityWhere`
   * browse-discovery predicate fix round 2 used. That predicate has no
   * invite_only branch, no extended_network branch, and no organizer bypass
   * — reusing it here wrongly HID an invited member's own bookmarked
   * invite_only event, a 2nd-degree viewer's bookmarked extended_network
   * event, and every organizer's OWN bookmarked network/community/
   * invite_only/extended_network event (nobody is "connected to
   * themselves", and an organizer can outlive their own community
   * membership). A saved list must answer "what have I already saved that I
   * can still see", not "what could I discover" — those are different
   * questions.
   *
   * `filterViewable` batches its own lookups across the WHOLE fetched page
   * (zero N+1 queries), so this stays one query for the join + one batched
   * filter pass, not one query per bookmarked event.
   *
   * PAGINATION SHAPE NOTE: because the filter runs AFTER the SQL
   * `.offset(skip).limit(take)`, a page can come back with FEWER than `take`
   * items when some of that page's bookmarks are no longer viewable (e.g. 3
   * of the 20 fetched are now `network`-only and the viewer isn't connected
   * to their hosts) — the short page is not backfilled from the next page.
   * Accepted for a user-scoped saved list: the alternative (over-fetch +
   * filter + trim to `take`, backfilling from subsequent pages as needed)
   * adds real complexity for a list that's typically small and where an
   * occasional short page is a minor, self-correcting cosmetic gap (the next
   * `GET` naturally continues from the same `skip`).
   */
  async listSaved(
    userId: string,
    skip: number,
    take: number,
  ): Promise<Event[]> {
    const events = await this.events
      .createQueryBuilder('e')
      .innerJoin(EventBookmark, 'b', 'b.event_id = e.id')
      .where('b.user_id = :userId', { userId })
      // Order by the bookmark's own timestamp — "most-recently-saved first".
      // Raw column (`b.created_at`), resolved directly in the main query's SQL;
      // no distinct-pass property-path translation is involved (see below).
      .orderBy('b.created_at', 'DESC')
      // `.offset()/.limit()` (raw SQL LIMIT/OFFSET), NOT `.skip()/.take()`.
      // `.skip()/.take()` with a join triggers TypeORM's distinct-id pagination
      // pass, whose subquery selects only the MAIN entity's columns — so an
      // ORDER BY on the JOINED alias's column (`b.created_at`) becomes an
      // unresolved `distinctAlias.b_created_at` and Postgres throws
      // "column ... does not exist". The distinct pass exists to dedupe rows a
      // join can fan out; here it can't — `UQ_event_bookmarks (user_id,
      // event_id)` makes this join strictly one bookmark row per event — so
      // plain LIMIT/OFFSET is both correct and lets the ORDER BY resolve.
      .offset(skip)
      .limit(take)
      .getMany();
    return this.audienceGate.filterViewable(events, userId);
  }

  /**
   * Which of `eventIds` the caller has bookmarked — a single `WHERE user_id AND
   * event_id IN (...)` lookup for a whole page of summaries, so the list/detail
   * `isBookmarked` flag never fans out into an N+1. Empty input skips the query.
   */
  async bookmarkedEventIds(
    userId: string,
    eventIds: string[],
  ): Promise<Set<string>> {
    if (!eventIds.length) return new Set();
    const rows = await this.bookmarks.find({
      where: { userId, eventId: In(eventIds) },
      select: { eventId: true },
    });
    return new Set(rows.map((row) => row.eventId));
  }

  /** Whether one event is bookmarked by the caller (event-detail flag). */
  isBookmarked(userId: string, eventId: string): Promise<boolean> {
    return this.bookmarks.exists({ where: { userId, eventId } });
  }

  // Bookmarks are addressed by the event's public slug (like every other events
  // sub-resource); resolve to the internal id, 404-ing an unknown slug.
  private async resolveEventId(slug: string): Promise<string> {
    const event = await this.events.findOne({
      where: { slug },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event.id;
  }

  // Like `resolveEventId`, but loads the full row — `bookmark()` needs it for
  // `assertViewable` (visibility, hostId, communityId, ...), not just the id.
  private async loadEventBySlug(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }
}
