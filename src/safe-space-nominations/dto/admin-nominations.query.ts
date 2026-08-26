import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SAFE_SPACE_NOMINATION_STATUSES,
  type SafeSpaceNominationStatus,
} from '../entities/safe-space-nomination.entity';

/** Which slice of the queue the operator wants. */
export const ADMIN_NOMINATION_SCOPES = ['open', 'decided', 'all'] as const;
export type AdminNominationScope = (typeof ADMIN_NOMINATION_SCOPES)[number];

/** How the queue is ordered. `oldest` is the default because the queue's whole
 * job is the 48-hour promise, and oldest-first is that promise sorted. */
export const ADMIN_NOMINATION_SORTS = ['oldest', 'newest'] as const;
export type AdminNominationSort = (typeof ADMIN_NOMINATION_SORTS)[number];

/**
 * Filters for `GET /admin/safe-space-nominations`. Everything is optional; with
 * no query at all the operator gets the open queue, oldest first, which is the
 * view somebody on shift actually wants.
 */
export class AdminNominationsQuery {
  @IsOptional()
  @IsIn(SAFE_SPACE_NOMINATION_STATUSES)
  status?: SafeSpaceNominationStatus;

  @IsOptional()
  @IsIn(ADMIN_NOMINATION_SCOPES)
  scope?: AdminNominationScope;

  /** Only nominations that have blown through the 48-hour acknowledgement
   * promise and are still unacknowledged. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  breachedOnly?: boolean;

  /** Only nominations already tied to a listing (visits are countable). */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  assignedOnly?: boolean;

  @IsOptional()
  @IsIn(ADMIN_NOMINATION_SORTS)
  sort?: AdminNominationSort;

  /** Case-insensitive match on the nominated place's name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
