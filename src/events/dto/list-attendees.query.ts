import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

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
  page?: number;
}
