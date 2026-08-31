import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { SubmissionStatus } from '../entities/magazine-story-submission.entity';

/** Query for the admin magazine-submission oversight list: paginated,
 * newest-first, optionally narrowed to a single submission status. */
export class ListAdminStorySubmissionsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(SubmissionStatus)
  status?: SubmissionStatus;
}
