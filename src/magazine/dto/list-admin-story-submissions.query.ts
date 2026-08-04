import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { SubmissionStatus } from '../entities/magazine-story-submission.entity';

/** Query for the admin magazine-submission oversight list: paginated,
 * newest-first, optionally narrowed to a single submission status. */
export class ListAdminStorySubmissionsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(SubmissionStatus)
  status?: SubmissionStatus;
}
