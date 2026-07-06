import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListJobsQuery {
  // Filters `Job.category`.
  @IsOptional() @IsString() cat?: string;

  // Filters `Job.commitment`.
  @IsOptional() @IsString() type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
