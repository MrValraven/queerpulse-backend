import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { EventListFilter } from '../events.service';

/** The `cost=` axis (LOC-18/LOC-17). `free` matches gatherings whose
 *  free-text cost reads as free (or that carry no cost at all, the historical
 *  default); `paid` matches gatherings that named a price that is not free.
 *  Deliberately three-state rather than a boolean, because "the host has not
 *  said" is a real answer and must not be silently sorted into either bucket
 *  by an absent query parameter. */
export const EVENT_COST_FILTERS = ['free', 'paid'] as const;
export type EventCostFilter = (typeof EVENT_COST_FILTERS)[number];

export class ListEventsQuery {
  // `saved` is backed by `event_bookmarks` (see `EventsService.list`).
  @IsOptional()
  @IsIn(['upcoming', 'going', 'hosting', 'waitlisted', 'past', 'saved'])
  filter?: EventListFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Narrow `filter=upcoming` to one host's other gatherings — the
  // `GatheringRecapPage` "more from this host" CTA. Only honoured on the
  // 'upcoming' branch (see `EventsService.list`); ignored by every other
  // filter, which already scope by a different actor (the viewer).
  @IsOptional()
  @IsString()
  hostSlug?: string;

  // Pairs with `hostSlug` — drops one event (the one the CTA is already on)
  // out of its own "more from this host" results.
  @IsOptional()
  @IsString()
  excludeSlug?: string;

  // ── Discovery filters (LOC-17) ───────────────────────────────────────────
  // "What is on this Friday near Arroios" used to be four clauses none of
  // which was expressible: the browse box and its chips filtered CLIENT-side
  // over whatever pages had loaded, so every answer under-reported until the
  // member had scrolled the whole feed. All five below are applied in SQL, so
  // they survive pagination and the counts are honest.
  //
  // Every one is honoured on the `upcoming` browse branch. `from`/`to`/`q`
  // are honoured on `past` too (a member narrowing their own history), and
  // ignored elsewhere: `going`/`hosting`/`waitlisted`/`saved` are already
  // scoped by the viewer's own relationship to the event.

  /** Inclusive lower bound on `startAt`, ISO-8601. On the `upcoming` branch
   *  it narrows the existing "from now" floor and can never widen it into the
   *  past. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Inclusive upper bound on `startAt`, ISO-8601. */
  @IsOptional()
  @IsISO8601()
  to?: string;

  /** A Lisbon neighbourhood, matched case-insensitively against the value the
   *  create wizard stored (`Event.neighbourhood`). Lisbon is the only city
   *  this product serves, so this is a plain string and not a city-scoped
   *  region id. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  hood?: string;

  /** A gathering type, matched case-insensitively against `Event.eventType`
   *  ("Supper club", "Workshop / talk", ...). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  /** Free-text search over title, venue, neighbourhood and description. Runs
   *  through the same ILIKE predicate (and the same trigram indexes) as the
   *  cross-entity search in `EventsService.searchByText`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** `free` or `paid` — see `EVENT_COST_FILTERS`. */
  @IsOptional()
  @IsIn(EVENT_COST_FILTERS)
  cost?: EventCostFilter;
}
