import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

export const AMBASSADOR_LIST_STATUSES = ['active', 'past'] as const;
export type AmbassadorListStatus = (typeof AMBASSADOR_LIST_STATUSES)[number];

/** Query for `GET /admin/ambassadors`. Absent `status` reads as `active`,
 *  absent `page` as the first page. */
export class ListAmbassadorsQuery {
  @IsOptional()
  @IsIn(AMBASSADOR_LIST_STATUSES)
  status?: AmbassadorListStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
