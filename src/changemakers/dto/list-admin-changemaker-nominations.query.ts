import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ChangemakerNominationStatus } from '../entities/changemaker-nomination.entity';

/** Query for the admin changemaker-nomination oversight list: paginated,
 * newest-first, optionally narrowed to one triage status (COM-17) — mirrors
 * `ListAdminWriterApplicationsQuery`. */
export class ListAdminChangemakerNominationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(ChangemakerNominationStatus)
  status?: ChangemakerNominationStatus;
}
