import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { EventListFilter } from '../events.service';

export class ListEventsQuery {
  @IsOptional()
  @IsIn(['upcoming', 'going', 'hosting', 'waitlisted', 'past', 'saved'])
  filter?: EventListFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
