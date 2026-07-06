import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
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
  page?: number;
}
