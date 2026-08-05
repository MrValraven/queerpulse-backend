import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

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
  page?: number;
}
