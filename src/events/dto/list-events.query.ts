import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
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
}
