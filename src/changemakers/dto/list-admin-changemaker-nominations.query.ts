import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { ChangemakerNominationStatus } from '../entities/changemaker-nomination.entity';

/** Query for the admin changemaker-nomination oversight list: paginated,
 * newest-first, optionally narrowed to one triage status (COM-17) — mirrors
 * `ListAdminWriterApplicationsQuery`. */
export class ListAdminChangemakerNominationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(ChangemakerNominationStatus)
  status?: ChangemakerNominationStatus;
}
