import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/** `GET /events/:slug/attendees?status=&page=` query. `status` defaults to
 *  `'going'` when omitted, so a bare `GET .../attendees` still resolves. */
export type AttendeeStatusFilter = 'going' | 'waitlisted';
export type AttendeeArrivalFilter = 'arrived' | 'expected';

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

  /** The door's two groups (organisers only, going only). */
  @IsOptional()
  @IsIn(['arrived', 'expected'])
  arrival?: AttendeeArrivalFilter;

  /** Name search, accent-folded server-side. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;
}
