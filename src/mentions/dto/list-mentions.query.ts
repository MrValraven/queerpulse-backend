import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/**
 * Query for `GET /mentions`. Mirrors `ListNotificationsQuery` (mentions are
 * notifications): optional `unread` filter and 1-based `page`.
 */
export class ListMentionsQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
