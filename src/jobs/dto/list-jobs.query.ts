import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

export class ListJobsQuery {
  // Filters `Job.category`. Both of these are matched against a short
  // vocabulary, so 120 is generous; the cap is here so no unbounded string
  // reaches the query builder.
  @IsOptional() @IsString() @MaxLength(120) cat?: string;

  // Filters `Job.commitment`.
  @IsOptional() @IsString() @MaxLength(120) type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
