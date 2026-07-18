import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListWorkshopsQuery {
  // Filters `Workshop.cat`. The frontend passes `SKILL_FILTERS`' value
  // ("design" | "tech" | "business" | "craft" | "care" | "creative"); its
  // "all" sentinel is sent as an absent `cat`, matching `ListJobsQuery`.
  @IsOptional() @IsString() cat?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
