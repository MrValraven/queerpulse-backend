import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** Query for the admin changemaker-nomination oversight list: paginated,
 * newest-first. The form captures only a free-text nominee name, so there is
 * no status/category axis to filter on. */
export class ListAdminChangemakerNominationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
