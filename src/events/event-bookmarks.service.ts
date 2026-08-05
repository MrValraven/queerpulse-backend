import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventBookmark } from './entities/event-bookmark.entity';
import { Event } from './entities/event.entity';

/**
 * Event bookmarks ("saved events"). Kept out of the already-large
 * `EventsService`; `EventsService` injects this for the read-side helpers it
 * needs (the `saved` list branch + the batch `isBookmarked` flag), and the
 * controller injects it for the write endpoints. This service depends only on
 * repositories (never back on `EventsService`), so it closes no DI cycle.
 */
@Injectable()
export class EventBookmarksService {
  constructor(
    @InjectRepository(EventBookmark)
    private readonly bookmarks: Repository<EventBookmark>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
  ) {}

  /**
   * Bookmark an event for the caller. Idempotent: a second bookmark of the same
   * event is absorbed by `ON CONFLICT DO NOTHING` against `UQ_event_bookmarks`,
   * so concurrent double-taps never 23505 — the endpoint always reports the
   * resulting "is bookmarked" truth.
   */
  async bookmark(userId: string, slug: string): Promise<{ bookmarked: true }> {
    const eventId = await this.resolveEventId(slug);
    await this.bookmarks
      .createQueryBuilder()
      .insert()
      .into(EventBookmark)
      .values({ eventId, userId })
      .orIgnore()
      .execute();
    return { bookmarked: true };
  }

  /**
   * Remove the caller's bookmark. Idempotent: removing a bookmark that isn't
   * there is a no-op that still reports the same final state. A missing event
   * 404s (parity with `bookmark`), rather than silently succeeding on a bad slug.
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
   */
  listSaved(userId: string, skip: number, take: number): Promise<Event[]> {
    return this.events
      .createQueryBuilder('e')
      .innerJoin(EventBookmark, 'b', 'b.event_id = e.id')
      .where('b.user_id = :userId', { userId })
      .orderBy('b.created_at', 'DESC')
      .skip(skip)
      .take(take)
      .getMany();
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
}
