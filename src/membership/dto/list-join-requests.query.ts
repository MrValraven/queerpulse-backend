import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PlatformJoinRequestStatus } from '../entities/join-request.entity';

export class ListJoinRequestsQuery {
  @IsOptional()
  @IsEnum(PlatformJoinRequestStatus)
  status?: PlatformJoinRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  // ISO timestamp of the last-seen row's createdAt from the previous page.
  // "Next page" always means "further along in the current sort order,"
  // computed against createdAt regardless of ASC/DESC.
  @IsOptional()
  @IsISO8601()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort?: 'oldest' | 'newest';

  /**
   * OPS-04's "Assigned to me" filter, as a closed set rather than a user id.
   *
   * `me` resolves to the CALLER server-side and `unassigned` to a NULL
   * assignee. Deliberately not "any user id you like": the queue only ever
   * needs to answer "mine" and "nobody's", and accepting an arbitrary id would
   * turn a filter into a way to enumerate what a named colleague is working on.
   */
  @IsOptional()
  @IsIn(['me', 'unassigned'])
  assignedTo?: 'me' | 'unassigned';
}
