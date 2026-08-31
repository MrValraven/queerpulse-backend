import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/** `GET /events/:slug/attendees?status=&page=` query. `status` defaults to
 *  `'going'` when omitted, so a bare `GET .../attendees` still resolves. */
export type AttendeeStatusFilter = 'going' | 'waitlisted';

export class ListAttendeesQuery {
  @IsOptional()
  @IsIn(['going', 'waitlisted'])
  status?: AttendeeStatusFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
