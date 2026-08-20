import { IsIn, IsOptional } from 'class-validator';

/**
 * Whether an edit / cancel / RSVP-cancel on a recurring occurrence applies to
 * just this one event (`'this'`, the default) or to it and every future
 * occurrence in its series (`'future'` — this occurrence's own
 * `seriesIndex` and every later one). Ignored (behaves as `'this'`) for an
 * event with no series. See `EventsService.update`/`cancel` and
 * `RsvpService.cancelRsvp`.
 */
export class SeriesScopeQuery {
  @IsOptional()
  @IsIn(['this', 'future'])
  scope?: 'this' | 'future';
}
