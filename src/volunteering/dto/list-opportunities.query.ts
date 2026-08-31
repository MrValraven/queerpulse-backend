import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  OpportunityCause,
  OpportunityCommitLevel,
} from '../entities/volunteer-opportunity.entity';

export class ListOpportunitiesQuery {
  // Filters `VolunteerOpportunity.cause`.
  @IsOptional() @IsEnum(OpportunityCause) cause?: OpportunityCause;

  // Filters `VolunteerOpportunity.commit`.
  @IsOptional() @IsEnum(OpportunityCommitLevel) commit?: OpportunityCommitLevel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
