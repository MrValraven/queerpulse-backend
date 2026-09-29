import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { JOB_COMMITMENT_IDS } from '../job-vocabulary';

export class ListJobsQuery {
  // Filters `Job.category`: a comma-separated list of job field ids (a board
  // group sends all of its fields). `JobsService` drops unknown ids; the cap
  // keeps an unbounded string away from the query builder.
  @IsOptional() @IsString() @MaxLength(600) cat?: string;

  // Filters `Job.commitment` by a `JOB_COMMITMENT_IDS` id.
  @IsOptional() @IsIn(JOB_COMMITMENT_IDS) type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
