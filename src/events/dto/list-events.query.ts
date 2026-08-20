import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { EventListFilter } from '../events.service';

export class ListEventsQuery {
  // `saved` is accepted but NOT YET BACKED — see the note on
  // `EventsService.list` / the controller Swagger: it always returns []
  // (no event-bookmark entity, deferred to Phase 2).
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
}
