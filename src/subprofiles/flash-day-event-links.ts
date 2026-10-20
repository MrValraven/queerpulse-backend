import { toImageUrl } from '../common/image-url';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import type { ItemStructured } from './entities/subprofile-item.entity';

// The public face of an event a `flash_days` item links to: the picker's
// option and the read side's `linkedEvent`. Hand-mapped field by field, so
// the event's `address` and `arrivalNotes` (the exact door) stay on the row.
export interface FlashDayEventRef {
  // The frontend links to `/gatherings/<slug>`.
  slug: string;
  title: string;
  // ISO string of `event.startAt`.
  startsAt: string;
  // ISO string of `event.endAt`, or null when the event has no end.
  endsAt: string | null;
  venue: string | null;
  neighbourhood: string | null;
  isOnline: boolean;
  // `event.coverImageUrl` resolved through `toImageUrl`.
  imageUrl: string | null;
}

export function toFlashDayEventRef(
  event: Pick<
    Event,
    | 'slug'
    | 'title'
    | 'startAt'
    | 'endAt'
    | 'venue'
    | 'neighbourhood'
    | 'isOnline'
    | 'coverImageUrl'
  >,
): FlashDayEventRef {
  return {
    slug: event.slug,
    title: event.title,
    startsAt: event.startAt.toISOString(),
    endsAt: event.endAt ? event.endAt.toISOString() : null,
    venue: event.venue ?? null,
    neighbourhood: event.neighbourhood ?? null,
    isOnline: event.isOnline,
    imageUrl: toImageUrl(event.coverImageUrl),
  };
}

// The event slug a `flash_days` item stores, trimmed. A missing, blank or
// non-string slug reads as no link.
export function flashDayEventSlugOf(
  structured: ItemStructured | null | undefined,
): string | null {
  const eventSlug: unknown = structured?.flashDay?.eventSlug;
  if (typeof eventSlug !== 'string') {
    return null;
  }
  const trimmedSlug = eventSlug.trim();
  return trimmedSlug.length ? trimmedSlug : null;
}

// A flash day may link only to an event anyone can see: published, with
// visibility `public`. Members-only, network, community and invite-only
// events, drafts and cancelled events all fail.
export function isLinkableFlashDayEvent(
  event: Pick<Event, 'status' | 'visibility'>,
): boolean {
  return (
    event.status === EventStatus.Published &&
    event.visibility === EventVisibility.Public
  );
}
